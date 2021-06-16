import http from 'http';
import ws from 'ws';
import { getErrorFromUnknown } from '../errors';
import { BaseOptions, CreateContextFn } from '../http';
import { getCombinedDataTransformer } from '../internals/getCombinedDataTransformer';
import { AnyRouter, ProcedureType } from '../router';
import {
  TRPCErrorResponse,
  TRPCReconnectNotification,
  TRPCRequest,
  TRPCResponse,
} from '../rpc';
import { Subscription } from '../subscription';
// https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent
const WEBSOCKET_STATUS_CODES = {
  ABNORMAL_CLOSURE: 1006,
};

/* istanbul ignore next */
function assertIsObject(obj: unknown): asserts obj is Record<string, unknown> {
  if (typeof obj !== 'object' || Array.isArray(obj) || !obj) {
    throw new Error('Not an object');
  }
}
/* istanbul ignore next */
function assertIsProcedureType(obj: unknown): asserts obj is ProcedureType {
  if (obj !== 'query' && obj !== 'subscription' && obj !== 'mutation') {
    throw new Error('Invalid procedure type');
  }
}
/* istanbul ignore next */
function assertIsRequestId(obj: unknown): asserts obj is number {
  if (typeof obj !== 'number' || isNaN(obj)) {
    throw new Error('Invalid requestId');
  }
}
/* istanbul ignore next */
function assertIsString(obj: unknown): asserts obj is string {
  if (typeof obj !== 'string') {
    throw new Error('Invalid string');
  }
}
/* istanbul ignore next */
function assertIsJSONRPC2OrUndefined(
  obj: unknown,
): asserts obj is '2.0' | undefined {
  if (typeof obj !== 'undefined' && obj !== '2.0') {
    throw new Error('Must be JSONRPC 2.0');
  }
}
function parseMessage(obj: unknown): TRPCRequest {
  assertIsObject(obj);
  const { method, params, id, jsonrpc } = obj;
  assertIsRequestId(id);
  assertIsJSONRPC2OrUndefined(jsonrpc);
  if (method === 'subscription.stop') {
    return {
      id,
      method,
      params: undefined,
    };
  }
  assertIsProcedureType(method);
  assertIsObject(params);

  const { input, path } = params;
  assertIsString(path);
  return { jsonrpc, id, method, params: { input, path } };
}

async function callProcedure<TRouter extends AnyRouter>(opts: {
  path: string;
  input: unknown;
  caller: ReturnType<TRouter['createCaller']>;
  type: ProcedureType;
}): Promise<unknown | Subscription<TRouter>> {
  const { type, path, input, caller } = opts;
  if (type === 'query') {
    return caller.query(path, input);
  }
  if (type === 'mutation') {
    return caller.mutation(path, input);
  }
  if (type === 'subscription') {
    const sub = (await caller.subscription(path, input)) as Subscription;
    return sub;
  }
  /* istanbul ignore next */
  throw new Error(`Unknown procedure type ${type}`);
}

/**
 * Web socket server handler
 */
export type WSSHandlerOptions<TRouter extends AnyRouter> = {
  router: TRouter;
  wss: ws.Server;
  createContext: CreateContextFn<TRouter, http.IncomingMessage, ws>;
  process?: NodeJS.Process;
} & BaseOptions<TRouter, http.IncomingMessage>;

export function applyWSSHandler<TRouter extends AnyRouter>(
  opts: WSSHandlerOptions<TRouter>,
) {
  const { router, wss, createContext } = opts;
  const transformer = getCombinedDataTransformer(opts.transformer);
  wss.on('connection', async (client, req) => {
    const clientSubscriptions = new Map<
      number | string,
      Subscription<TRouter>
    >();

    function respond(json: TRPCResponse) {
      client.send(JSON.stringify(json));
    }
    function subscriptionResponse(result: TRPCResponse) {
      respond(result);
    }
    try {
      const ctx = await createContext({ req, res: client });
      const caller = router.createCaller(ctx);

      async function handleRequest(msg: TRPCRequest) {
        const { id } = msg;
        if (msg.method === 'subscription.stop') {
          const sub = clientSubscriptions.get(id);
          clientSubscriptions.delete(id);
          if (sub) {
            sub.destroy();
            subscriptionResponse({
              id,
              result: {
                type: 'stopped',
              },
            });
          }
          return;
        }
        const input = transformer.input.deserialize(msg.params.input);
        const { path } = msg.params;
        const type = msg.method;
        try {
          const result = await callProcedure({ path, input, type, caller });

          if (!(result instanceof Subscription)) {
            respond({
              id,
              result: {
                type: 'data',
                data: transformer.output.serialize(result),
              },
            });
            return;
          }

          subscriptionResponse({
            id,
            result: {
              type: 'started',
            },
          });
          const sub = result;
          /* istanbul ignore next */
          if (client.readyState !== client.OPEN) {
            // if the client got disconnected whilst initializing the subscription
            sub.destroy();
            return;
          }
          /* istanbul ignore next */
          if (clientSubscriptions.has(id)) {
            // duplicate request ids for client
            sub.destroy();
            throw new Error(`Duplicate id ${id}`);
          }
          clientSubscriptions.set(id, sub);
          sub.on('data', (data: unknown) => {
            subscriptionResponse({
              id,
              result: {
                type: 'data',
                data: transformer.output.serialize(data),
              },
            });
          });
          sub.on('error', (_error: unknown) => {
            const error = getErrorFromUnknown(_error);
            const json: TRPCErrorResponse = {
              id,
              error: transformer.output.serialize(
                router.getErrorShape({
                  error,
                  type,
                  path,
                  input,
                  ctx,
                }),
              ),
            };
            opts.onError?.({ error, path, type, ctx, req, input });
            respond(json);
          });
          sub.on('destroy', () => {
            subscriptionResponse({
              id,
              result: {
                type: 'stopped',
              },
            });
          });
          await sub.start();
        } catch (_error) /* istanbul ignore next */ {
          // procedure threw an error
          const error = getErrorFromUnknown(_error);
          const json = router.getErrorShape({
            error: _error,
            type,
            path,
            input,
            ctx,
          });
          opts.onError?.({ error, path, type, ctx, req, input });
          respond({ id, error: transformer.output.serialize(json) });
        }
      }
      client.on('message', async (message) => {
        const msgJSON = JSON.parse(message as string);
        const msgs = Array.isArray(msgJSON) ? msgJSON : [msgJSON];
        msgs.map(parseMessage).map(handleRequest);
      });

      client.once('close', () => {
        for (const sub of clientSubscriptions.values()) {
          sub.destroy();
        }
        clientSubscriptions.clear();
      });
    } catch (err) /* istanbul ignore next */ {
      // failed to create context
      const error = getErrorFromUnknown(err);

      client.send({
        id: -1,
        error: router.getErrorShape({
          error,
          type: 'unknown',
          path: undefined,
          input: undefined,
          ctx: undefined,
        }),
      });
      opts.onError?.({
        error,
        path: undefined,
        type: 'unknown',
        ctx: undefined,
        req,
        input: undefined,
      });
      client.close(WEBSOCKET_STATUS_CODES.ABNORMAL_CLOSURE);
    }
  });

  return {
    broadcastReconnectNotification: () => {
      const response: TRPCReconnectNotification = {
        id: null,
        method: 'reconnect',
      };
      const data = JSON.stringify(response);
      for (const client of wss.clients) {
        if (client.readyState === 1 /* ws.OPEN */) {
          client.send(data);
        }
      }
    },
  };
}
