import {test} from 'node:test';
import assert from 'node:assert/strict';
import R from '../domain/rules.cjs';

const at = ds => Date.parse(ds+'T23:00:00+08:00');
function fixture(hireDate='2026-09-15') {
  const emp={id:'e',name:'测试',salary:3000,commissionRate:10,hireDate,createdAt:at('2026-10-06')};
  return {settings:{payDay:15,tzOffset:8,inDL:'11:00',taskDL:'16:00',undoneRatio:.5,installedAt:'2026-10-06'},employees:[emp],records:{},perf:[],payrolls:[],audit:[]};
}
function normal(db,start,end) {
  const [y,m,d]=R.splitDs(start);
  for(let i=0;i<R.dateCount(start,end);i++) db.records['e|'+R.ymd(y,m,d+i)]={manualStatus:'normal'};
}
test('payday starts a new cycle; exact inclusive spans across months, leap years and years',()=>{
  const st={payDay:15};
  for(const [date,start,end,pay,days] of [
    ['2026-10-06','2026-09-15','2026-10-14','2026-10-15',30],
    ['2026-10-14','2026-09-15','2026-10-14','2026-10-15',30],
    ['2026-10-15','2026-10-15','2026-11-14','2026-11-15',31],
    ['2028-03-01','2028-02-15','2028-03-14','2028-03-15',29],
    ['2027-03-01','2027-02-15','2027-03-14','2027-03-15',28],
    ['2027-01-01','2026-12-15','2027-01-14','2027-01-15',31],
  ]) {
    const c=R.cycleForDate(st,date);assert.deepEqual([c.start,c.end,c.payDate,c.days],[start,end,pay,days]);
  }
  assert.equal(R.cycleForDate({payDay:1},'2026-10-01').start,'2026-10-01');
});
test('full cycle earns exactly monthly salary; performance and divisor follow same cycle',()=>{
  const db=fixture(),emp=db.employees[0];normal(db,'2026-09-15','2026-11-14');
  db.perf=['2026-09-14','2026-09-15','2026-09-30','2026-10-14','2026-10-15'].map(date=>({empId:'e',date,amount:1000}));
  let c=R.computeCycle(db,emp,R.cycleForDate(db.settings,'2026-10-06'),at('2026-11-15'));
  assert.equal(c.base,3000);assert.equal(c.rate,100);assert.equal(c.perfTotal,3000);assert.equal(c.amount,3300);
  c=R.computeCycle(db,emp,R.cycleForDate(db.settings,'2026-10-15'),at('2026-11-15'));
  assert.equal(c.base,3000);assert.equal(c.rate,3000/31);assert.equal(c.commission,100);
  assert.equal(R.computeCurrentCycle(db,emp,at('2026-10-06')).base,2200,'Includes September 15 onward');
});
test('settle on October 15 without a month delay, even for backdated hire; reruns idempotent',()=>{
  const db=fixture();normal(db,'2026-09-15','2026-10-14');let id=0;
  assert.equal(R.ensurePayrolls(db,at('2026-10-14'),()=>++id).length,0);
  assert.equal(R.ensurePayrolls(db,at('2026-10-15'),()=>++id).length,1);
  const p=db.payrolls[0];assert.equal(p.payDate,'2026-10-15');assert.equal(p.cycleStart,'2026-09-15');assert.equal(p.amount,3000);
  R.ensurePayrolls(db,at('2026-10-15'),()=>++id);assert.equal(db.payrolls.length,1);
  db.records['e|2026-09-20'].manualStatus='late';R.syncPayroll(db,'e','2026-09-20',at('2026-10-15'));
  assert.equal(p.base,2950,'September edit recalculates October payday');
  p.paid=true;db.records['e|2026-09-20'].manualStatus='absent';R.syncPayroll(db,'e','2026-09-20',at('2026-10-15'));assert.equal(p.base,2950);
});
test('legacy unpaid snapshots archived; paid amount preserved and overlap excluded exactly once',()=>{
  const db=fixture('2026-09-01');normal(db,'2026-09-01','2026-10-14');
  db.payrolls=[{id:'paid',empId:'e',period:'2026-09',payDate:'2026-10-15',amount:2987.65,paid:true},
    {id:'pending',empId:'e',period:'2026-10',payDate:'2026-11-15',amount:100,paid:false}];
  db.perf=[{empId:'e',date:'2026-09-20',amount:1000},{empId:'e',date:'2026-10-02',amount:500}];
  R.migratePayrollCycles(db,at('2026-10-15'));R.migratePayrollCycles(db,at('2026-10-15'));
  assert.equal(db.payrollArchive.length,1);assert.equal(db.payrolls[0].amount,2987.65);assert.equal(db.audit.length,1);
  R.ensurePayrolls(db,at('2026-10-15'),()=> 'new');
  const c=db.payrolls.find(p=>p.payrollBasis==='pay-cycle');
  assert.equal(c.excludedPaidDays,16);assert.equal(c.eligible,14);assert.equal(c.base,1400);assert.equal(c.commission,50);
  assert.equal(db.payrolls.length,2,'Fully paid earlier period does not regenerate');
  db.payrolls[0].paid=false;R.migratePayrollCycles(db,at('2026-10-15'));
  R.ensurePayrolls(db,at('2026-10-15'),()=> 'new2');db.payrolls.forEach(p=>R.recalcPayroll(db,p,at('2026-10-15')));
  assert.equal(c.base,3000,'Unmarking old payroll restores excluded days');
});
