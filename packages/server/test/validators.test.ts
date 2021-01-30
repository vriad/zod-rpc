/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/ban-types */
import '@testing-library/jest-dom';
import { createTRPCClient } from '@trpc/client';
import AbortController from 'abort-controller';
import myzod from 'myzod';
import fetch from 'node-fetch';
import * as yup from 'yup';
import * as z from 'zod';
import * as trpc from '../src';
import { AnyRouter } from '../src';
import { createHttpServer } from '../src/adapters/standalone';
import { createSchema as tsJsonSchema, TsjsonParser } from 'ts-json-validator';

async function expectError<TPromise extends Promise<any>>(promise: TPromise) {
  try {
    await promise;
    throw new Error('Did not throw');
  } catch (err) {
    return err as Error;
  }
}
function routerToServerAndClient<TRouter extends AnyRouter>(router: TRouter) {
  const server = createHttpServer({
    router,
    createContext: () => ({}),
  });
  const { port } = server.listen(0);

  const client = createTRPCClient<typeof router>({
    url: `http://localhost:${port}`,
    fetchOpts: {
      AbortController: AbortController as any,
      fetch: fetch as any,
    },
  });

  return {
    client,
    close: () => server.server.close(),
  };
}
test('no validator', async () => {
  const router = trpc.router().query('hello', {
    resolve() {
      return 'test';
    },
  });
  const { client, close } = routerToServerAndClient(router);
  const res = await client.query('hello');
  expect(res).toBe('test');
  close();
});

test('zod', async () => {
  const router = trpc.router().query('num', {
    input: z.number(),
    resolve({ input }) {
      return {
        input,
      };
    },
  });
  const { client, close } = routerToServerAndClient(router);
  const res = await client.query('num', 123);

  expect(await expectError(client.query('num', '123' as any)))
    .toMatchInlineSnapshot(`
      [Error: 1 validation issue(s)

        Issue #0: invalid_type at 
        Expected number, received string
      ]
    `);
  expect(res.input).toBe(123);
  close();
});

test('yup', async () => {
  const router = trpc.router().query('num', {
    input: yup.number().required(),
    resolve({ input }) {
      return {
        input,
      };
    },
  });
  const { client, close } = routerToServerAndClient(router);
  const res = await client.query('num', 123);

  expect(
    await expectError(client.query('num', '123' as any)),
  ).toMatchInlineSnapshot(`[Error: Did not throw]`);
  expect(res.input).toBe(123);
  close();
});

test('myzod', async () => {
  const router = trpc.router().query('num', {
    input: myzod.number(),
    resolve({ input }) {
      return {
        input,
      };
    },
  });
  const { client, close } = routerToServerAndClient(router);
  const res = await client.query('num', 123);
  expect(
    await expectError(client.query('num', '123' as any)),
  ).toMatchInlineSnapshot(`[Error: expected type to be number but got string]`);
  expect(res.input).toBe(123);
  close();
});

test('ts-json-validator', async () => {
  const router = trpc.router().query('num', {
    input: new TsjsonParser(
      tsJsonSchema({
        type: 'number',
      }),
    ),
    resolve({ input }) {
      return {
        input,
      };
    },
  });
  const { client, close } = routerToServerAndClient(router);
  const res = await client.query('num', 123);
  expect(
    await expectError(client.query('num', 'asdasd' as any)),
  ).toMatchInlineSnapshot(`[Error: Unexpected token a in JSON at position 0]`);
  expect(res.input).toBe(123);
  close();
});

test('validator fn', async () => {
  function numParser(input: unknown) {
    if (typeof input !== 'number') {
      throw new Error('Not a number');
    }
    return input;
  }
  const router = trpc.router().query('num', {
    input: numParser,
    resolve({ input }) {
      return {
        input,
      };
    },
  });
  const { client, close } = routerToServerAndClient(router);
  const res = await client.query('num', 123);
  expect(
    await expectError(client.query('num', '123' as any)),
  ).toMatchInlineSnapshot(`[Error: Not a number]`);
  expect(res.input).toBe(123);
  close();
});
