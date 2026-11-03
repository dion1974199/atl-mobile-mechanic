// Offline PostgreSQL-compatible execution. Install PGlite outside the app:
// npm install --prefix /tmp/atl-risk-test --ignore-scripts @electric-sql/pglite
const { PGlite } = require(process.env.PGLITE_MODULE || '/tmp/atl-risk-test/node_modules/@electric-sql/pglite');
const fs = require('node:fs');
const assert = require('node:assert/strict');
(async () => {
 const db = new PGlite();
 await db.exec(`CREATE SCHEMA auth; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
 CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'service_role'::text $$;
 CREATE TABLE service_payments(id uuid PRIMARY KEY, request_id uuid, customer_id uuid, provider_id uuid,
 stripe_payment_intent_id text, payment_status text DEFAULT 'pending', transfer_status text DEFAULT 'not_transferred',
 stripe_transfer_id text, single_transfer_attempted_at timestamptz, split_transfer_attempted_at timestamptz,
 authorized_amount numeric, marketplace_fee_amount numeric, marketplace_fee_percent numeric,
 paid_at timestamptz, provider_transferred_at timestamptz, payment_error text, provider_amount numeric, currency text DEFAULT 'usd', transfer_error text, updated_at timestamptz, stripe_charge_id text);
 CREATE TABLE service_payment_parts(id uuid PRIMARY KEY, service_payment_id uuid, payment_status text,
 stripe_payment_intent_id text, stripe_charge_id text, amount_cents bigint);
 CREATE TABLE service_requests(id uuid, customer_id uuid, provider_id uuid, status text, customer_confirmed_at timestamptz);`);
 for (const name of ['20261022135144_payment_refund_dispute_safeguards.sql','20261022210000_verified_payment_risk_holds.sql','20261022213000_single_transfer_completion_recovery.sql']) {
  await db.exec(fs.readFileSync('supabase/migrations/' + name, 'utf8'));
 }
 const bill='00000000-0000-0000-0000-000000000001';
 const req='00000000-0000-0000-0000-000000000002';
 await db.query(`INSERT INTO service_payments(id,request_id,customer_id,provider_id,stripe_payment_intent_id) VALUES ($1,$2,$1,$1,'pi_1')`,[bill,req]);
 await db.query(`INSERT INTO service_requests VALUES ($1,$2,$2,'completed',now())`,[req,bill]);
 const scalar = async (sql, args=[]) => Object.values((await db.query(sql,args)).rows[0])[0];
 const hold = (reason='refund',ref='re_1') => scalar(`SELECT record_verified_payment_payout_hold($1,'pi_1','ch_1',$2,$3,'succeeded')`,[bill,reason,ref]);
 assert.equal(await hold(),true);
 assert.equal(await scalar('SELECT claim_single_payment_transfer($1)',[bill]),false);
 await hold(); assert.equal(await scalar('SELECT payout_hold_reason FROM service_payments'),'refund');
 await hold('dispute','dp_1'); assert.equal(await scalar('SELECT payout_hold_reason FROM service_payments'),'manual_review');
 await db.query(`SELECT record_payment_payout_hold($1,'dispute','dp_1','won')`,[bill]);
 await db.query(`SELECT record_payment_payout_hold($1,'dispute','dp_1','needs_response')`,[bill]);
 assert.equal(await scalar('SELECT stripe_dispute_status FROM service_payments'),'won');
 await db.query(`SELECT record_payment_payout_hold($1,'dispute','dp_other','lost')`,[bill]);
 assert.equal(await scalar('SELECT stripe_dispute_status FROM service_payments'),'won');
 await db.exec(`UPDATE service_payments SET payout_hold_reason=NULL, single_transfer_attempted_at=now(), transfer_status='processing'`);
 await hold(); assert.equal(await scalar('SELECT payout_hold_reason FROM service_payments'),'manual_review');
 await assert.rejects(()=>scalar(`SELECT record_verified_payment_payout_hold($1,'pi_wrong','ch_1','refund','re_1','pending')`,[bill]));
 await db.exec(`UPDATE service_payments SET payout_hold_reason='refund', single_transfer_attempted_at=NULL`);
 assert.equal(await scalar('SELECT begin_single_transfer_attempt($1)',[bill]),false);
 await db.exec(`UPDATE service_payments SET stripe_payment_intent_id=NULL`);
 assert.equal(await scalar('SELECT begin_split_transfer_attempt($1)',[bill]),false);
 await db.exec(`UPDATE service_payments SET payout_hold_reason=NULL, single_transfer_attempted_at=now()`);
 assert.equal(await scalar('SELECT begin_split_transfer_attempt($1)',[bill]),false);

 // Exercise completion with the live function's signature and a late risk hold.
 await db.exec(`UPDATE service_payments SET stripe_payment_intent_id='pi_1',
   single_transfer_attempted_at=now(), split_transfer_attempted_at=NULL,
   transfer_status='processing', payment_status='pending', stripe_charge_id='ch_1',
   payout_hold_reason='refund', payout_hold_at=now(), transfer_error='review outstanding'`);
 const complete = (transfer='tr_1',charge='ch_1') => scalar(
   'SELECT complete_single_payment_transfer($1,$2,$3)',[bill,transfer,charge]);
 await assert.rejects(()=>complete('tr_1','ch_other'));
 await assert.rejects(()=>complete('not-a-transfer'));
 assert.equal(await complete(),true);
 assert.equal(await scalar('SELECT payout_hold_reason FROM service_payments'),'manual_review');
 assert.equal(await scalar('SELECT transfer_error FROM service_payments'),'review outstanding');
 assert.equal(await complete(),true); // Identical replay only.
 await assert.rejects(()=>complete('tr_other'));
 assert.equal(await scalar('SELECT claim_single_payment_transfer($1)',[bill]),false);
 assert.equal(await scalar("SELECT has_function_privilege('authenticated','public.complete_single_payment_transfer(uuid,text,text)','EXECUTE')"),false);
 assert.equal(await scalar("SELECT has_function_privilege('anon','public.claim_single_payment_transfer(uuid)','EXECUTE')"),false);
 // Completion without an attempt must never manufacture a settled transfer.
 await db.exec(`UPDATE service_payments SET stripe_transfer_id=NULL, transfer_status='processing',
   payment_status='pending', single_transfer_attempted_at=NULL`);
 await assert.rejects(()=>complete());
 await db.exec(`CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'authenticated'::text $$`);
 await assert.rejects(hold);
 console.log('PASS: migrations execute; duplicate/conflicting holds, late attempts, ownership mismatch, both attempt gates, service-role enforcement');
 await db.close();
})().catch(error=>{ console.error(error); process.exitCode=1; });
