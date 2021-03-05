/* eslint-disable @typescript-eslint/no-explicit-any */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import { getErrorResponseEnvelope, TRPCResponseError } from '../errors';
import {
  BaseOptions,
  CreateContextFn,
  CreateContextFnOptions,
  requestHandler,
} from '../http';
import { AnyRouter } from '../router';

export type CreateNextContextOptions = CreateContextFnOptions<
  NextApiRequest,
  NextApiResponse
>;

export type CreateNextContextFn<TContext> = CreateContextFn<
  TContext,
  NextApiRequest,
  NextApiResponse
>;
export function createNextApiHandler<
  TContext,
  TRouter extends AnyRouter<TContext>
>(
  opts: {
    router: TRouter;
    createContext: CreateNextContextFn<TContext>;
  } & BaseOptions,
): NextApiHandler {
  return async (req, res) => {
    function getPath(): string | null {
      if (typeof req.query.trpc === 'string') {
        return req.query.trpc;
      }
      if (Array.isArray(req.query.trpc)) {
        return req.query.trpc.join('/');
      }
      return null;
    }
    const path = getPath();

    if (path === null) {
      const json = getErrorResponseEnvelope(
        new TRPCResponseError({
          statusCode: 500,
          message:
            'Query "trpc" not found - is the file named `[trpc]`.ts or `[...trpc].ts`?',
          path: '',
          originalError: null,
          procedureType: 'unknown',
        }),
      );
      res.status(json.statusCode).json(json);
      return;
    }

    await requestHandler({
      ...opts,
      req,
      res,
      path,
    });
  };
}
