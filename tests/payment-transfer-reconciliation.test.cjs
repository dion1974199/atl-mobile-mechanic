const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, mocks) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText;

  vm.runInNewContext(code, {
    exports,
    require: name => {
      if (!(name in mocks)) throw Error(`Unexpected dependency ${name}`);
      return mocks[name];
    }
  });

  return exports;
}

const transfer = {
  id: 'tr_existing',
  amount: 8500,
  currency: 'usd',
  destination: 'acct_provider',
  transfer_group: 'group_request',
  metadata: {
    service_payment_id: 'bill',
    service_request_id: 'request',
    payment_mode: 'single'
  },
  reversed: false,
  amount_reversed: 0
};

test('transfer lookup finds existing payout', async () => {
  const { findSingleTransfer } = load(
    'lib/stripe/find-single-transfer.ts',
    { stripe: {} }
  );

  const stripe = {
    transfers: {
      list: async function* () {
        yield { ...transfer, metadata: { service_payment_id: 'other' } };
        yield transfer;
      }
    }
  };

  assert.equal((await findSingleTransfer(stripe, 'bill')).id, 'tr_existing');
});

test('transfer lookup rejects multiple matching payouts', async () => {
  const { findSingleTransfer } = load(
    'lib/stripe/find-single-transfer.ts',
    { stripe: {} }
  );

  const stripe = {
    transfers: {
      list: async function* () {
        yield transfer;
        yield { ...transfer, id: 'tr_duplicate' };
      }
    }
  };

  await assert.rejects(
    () => findSingleTransfer(stripe, 'bill'),
    /Multiple Stripe transfers/
  );
});

test('uncertain transfer outcome never creates another payout', async () => {
  let creates = 0;
  let completions = 0;

  const admin = {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: {
              payment_status: 'paid',
              transfer_status: 'processing',
              stripe_transfer_id: null,
              stripe_charge_id: 'ch_1',
              single_transfer_attempted_at: '2026-11-03T12:00:00Z'
            },
            error: null
          })
        })
      })
    }),
    rpc: async () => {
      completions++;
      return { data: true, error: null };
    }
  };

  const { reconcileSingleTransfer } = load(
    'lib/stripe/reconcile-single-transfer.ts',
    {
      stripe: {},
      '@/lib/supabase/admin': { createAdminClient: () => admin },
      '@/lib/stripe/find-single-transfer': {
        findSingleTransfer: async () => null,
        verifySingleTransfer: () => {}
      }
    }
  );

  const stripe = {
    transfers: {
      create: async () => { creates++; }
    }
  };

  await assert.rejects(
    () => reconcileSingleTransfer(
      stripe, 'bill', 'request', 'acct_provider',
      8500, 'group_request', 'ch_1'
    ),
    /manual review required/
  );

  assert.equal(creates, 0);
  assert.equal(completions, 0);
});
