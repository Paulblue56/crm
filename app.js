(() => {
  const KEY = 'crm-finance-workspace-v1';
  const ACCOUNTS_KEY = 'crm-local-accounts-v1';
  const SESSION_KEY = 'crm-current-account-v1';
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const money = n => `KES ${Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const emptyState = { companies: [], payroll: [], invoices: [], activities: [] };
  let db = { ...emptyState };
  let activeAccount = null;
  let activeView = 'overview';
  const now = new Date();
  const activeMonth = MONTHS[now.getMonth()];
  const activeYear = now.getFullYear();
  let modalMode = '';
  const supabaseConfig = window.CRM_SUPABASE_CONFIG || {};
  const cloudClient = window.supabase && supabaseConfig.url && supabaseConfig.anonKey && !supabaseConfig.url.includes('YOUR_')
    ? window.supabase.createClient(supabaseConfig.url, supabaseConfig.anonKey) : null;
  let cloudUserId = null, cloudSaveTimer = 0;
  const cloudReady = () => !!cloudClient;

  function accountKey(email) { return `${KEY}:${String(email).toLowerCase()}`; }
  function loadWorkspace(email) { try { return { ...emptyState, ...JSON.parse(localStorage.getItem(accountKey(email)) || '{}') }; } catch { return { ...emptyState }; } }
  function migrateLegacyWorkspace(email) { if(localStorage.getItem(accountKey(email))||!localStorage.getItem(KEY))return;try{localStorage.setItem(accountKey(email),JSON.stringify({...emptyState,...JSON.parse(localStorage.getItem(KEY))}));}catch{}}
  function save() {
    if (!activeAccount) return;
    localStorage.setItem(accountKey(activeAccount.email), JSON.stringify(db)); renderAll();
    if (cloudUserId) {
      clearTimeout(cloudSaveTimer); cloudSaveTimer=setTimeout(async()=>{
        const {error}=await cloudClient.from('crm_workspaces').upsert({user_id:cloudUserId,data:db,updated_at:new Date().toISOString()},{onConflict:'user_id'});
        if(error) toast('Cloud sync failed; this browser still has your saved changes.');
      },700);
    }
  }
  async function loadCloudWorkspace(user) {
    cloudUserId=user.id;
    const {data,error}=await cloudClient.from('crm_workspaces').select('data').eq('user_id',user.id).maybeSingle();
    if(error) throw error;
    const local=loadWorkspace(user.email);
    if(data?.data) db={...emptyState,...data.data};
    else {
      const hasLocal=local.companies.length||local.payroll.length||local.invoices.length;
      if(hasLocal && window.confirm('This Supabase account has no saved CRM workspace. Upload this browser’s company details, employee PINs, payroll, VAT invoices, and activity to your account so you can use them on other devices?')) {
        db=local;
        const {error:writeError}=await cloudClient.from('crm_workspaces').upsert({user_id:user.id,data:db,updated_at:new Date().toISOString()},{onConflict:'user_id'});
        if(writeError) throw writeError;
      } else db={...emptyState};
    }
    localStorage.setItem(accountKey(user.email),JSON.stringify(db));
  }
  function addActivity(message, kind = 'record') {
    db.activities.unshift({ id: crypto.randomUUID(), message, kind, at: new Date().toISOString() });
    db.activities = db.activities.slice(0, 8);
  }
  function effective(list, date) {
    const d = new Date(`${date}T00:00:00`);
    return list.filter(x => new Date(`${x.from}T00:00:00`) <= d).at(-1);
  }
  function isoFor(year, month) { return `${year}-${String(MONTHS.indexOf(month) + 1).padStart(2,'0')}-15`; }
  function computePayroll(input, period) {
    const when = isoFor(input.year || period.year, input.month || period.month);
    const nssfRule = effective(CRM_RULES.nssf, when);
    const shifRule = effective(CRM_RULES.shif, when);
    const ahlRule = effective(CRM_RULES.ahl, when);
    const payeRule = effective(CRM_RULES.paye, when);
    const gross = Math.max(0, Number(input.gross || 0));
    const pensionable = Math.max(0, Number(input.pensionable ?? input.cash ?? gross));
    const nssf = nssfRule ? Math.min(pensionable, nssfRule.lower) * .06 + Math.max(0, Math.min(pensionable, nssfRule.upper) - nssfRule.lower) * .06 : 0;
    const shif = shifRule ? Math.max(shifRule.minimum, gross * shifRule.rate) : 0;
    const ahl = ahlRule ? gross * ahlRule.employeeRate : 0;
    const employerAhl = ahlRule ? gross * ahlRule.employerRate : 0;
    const employerNssf = nssf;
    const pensionRequested = Math.max(0, Number(input.registeredPension || 0));
    const pensionDeduction = Math.min(pensionRequested, Math.max(0, 30000 - nssf));
    const prmfDeduction = Math.min(Math.max(0, Number(input.prmf || 0)), 15000);
    const mortgageDeduction = Math.min(Math.max(0, Number(input.mortgageInterest || 0)), 30000);
    const taxable = Math.max(0, gross - nssf - shif - ahl - pensionDeduction - prmfDeduction - mortgageDeduction);
    const bands = payeRule?.bands || [];
    let remaining = taxable, grossTax = 0;
    for (const [width, rate] of bands) { const part = Math.min(remaining, width); grossTax += part * rate; remaining = Math.max(0, remaining - part); if (!remaining) break; }
    const isResident = String(input.residential || 'Resident').toLowerCase().includes('resident') && !String(input.residential || '').toLowerCase().includes('non');
    const personalRelief = isResident ? (payeRule?.residentRelief || 0) : 0;
    const insuranceRelief = Math.min(Math.max(0, Number(input.insurancePremiums || 0)) * .15, 5000);
    const paye = Math.max(0, grossTax - personalRelief - insuranceRelief);
    return { gross, nssf, employerNssf, shif, ahl, employerAhl, pensionDeduction, prmfDeduction, mortgageDeduction, taxable, grossTax, personalRelief, insuranceRelief, paye, employerCost: gross + employerNssf + employerAhl, rules: { paye: payeRule?.from, nssf: nssfRule?.from, shif: shifRule?.from, ahl: ahlRule?.from } };
  }
  function vatRate(taxType, date) {
    const type = String(taxType || 'VAT').toLowerCase();
    if (type.includes('exempt')) return { rate: 0, rule: 'Exempt' };
    if (type.includes('zero')) return { rate: 0, rule: 'Zero-rated' };
    if (type.includes('fuel') || type.includes('section g') || type.includes('petroleum') || type.includes('kerosene') || type.includes('gas oil')) {
      const schedule = effective(CRM_RULES.vat, date);
      const isSpecificProduct = /premium motor spirit|premium petrol|illuminating kerosene|automotive gas oil|diesel/i.test(type) || type === 'fuel' || type.includes('section g');
      const inTemporaryWindow = date >= CRM_RULES.reducedPetroleum.from && date <= CRM_RULES.reducedPetroleum.through;
      const historicalReducedRate = date >= '2018-09-21' && date < '2023-07-01';
      if (inTemporaryWindow && isSpecificProduct) return { rate: schedule?.petroleum ?? .08, rule: `Petroleum relief ${CRM_RULES.reducedPetroleum.from}–${CRM_RULES.reducedPetroleum.through}` };
      if (historicalReducedRate) return { rate: schedule?.petroleum ?? .08, rule: schedule?.from };
      if (date === '2026-04-15' && isSpecificProduct) return { rate: .13, rule: 'Temporary petroleum order effective 2026-04-15' };
      return { rate: schedule?.standard ?? .16, rule: schedule?.from };
    }
    const schedule = effective(CRM_RULES.vat, date);
    return { rate: schedule?.standard ?? .16, rule: schedule?.from };
  }
  function taxRecord(raw) {
    const computed = computePayroll(raw, raw);
    return { ...raw, ...computed, id: raw.id || crypto.randomUUID(), createdAt: raw.createdAt || new Date().toISOString(), payeSource: raw.payeSource || 'CRM calculation' };
  }
  function companyOptions(select, selected, includeAll = false) {
    if (!select) return;
    select.innerHTML = `${includeAll ? '<option value="all">All companies</option>' : ''}${db.companies.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}`;
    if (selected && [...select.options].some(o => o.value === selected)) select.value = selected;
    else if (includeAll) select.value = 'all';
  }
  function addPeriodOptions(monthId, yearId, month = activeMonth, year = activeYear) {
    const m = $(`#${monthId}`), y = $(`#${yearId}`);
    if (m) { m.innerHTML = MONTHS.map(x => `<option>${x}</option>`).join(''); m.value = month; }
    if (y) { const min = Math.min(2023, year - 2), max = Math.max(2035, year + 2); y.innerHTML = Array.from({length:max-min+1},(_,i)=>min+i).map(v=>`<option value="${v}">${v}</option>`).join(''); y.value = year; }
  }
  function payrollPeriod() { return { companyId: $('#payroll-company')?.value || '', month: $('#payroll-month')?.value || activeMonth, year: Number($('#payroll-year')?.value || activeYear) }; }
  function vatPeriod() { return { companyId: $('#vat-company')?.value || '', month: $('#vat-month')?.value || activeMonth, year: Number($('#vat-year')?.value || activeYear), type: $('#vat-type')?.value || 'all' }; }
  function periodRows() { const p = payrollPeriod(); return db.payroll.filter(r => r.companyId === p.companyId && r.month === p.month && Number(r.year) === p.year); }
  function periodInvoices() { const p = vatPeriod(); return db.invoices.filter(r => r.companyId === p.companyId && r.month === p.month && Number(r.year) === p.year && (p.type === 'all' || r.direction === p.type)); }
  function renderOverview() {
    const pRows = db.payroll.filter(r => r.month === activeMonth && Number(r.year) === activeYear);
    const invoices = db.invoices.filter(r => r.month === activeMonth && Number(r.year) === activeYear);
    const employees = new Set(db.payroll.map(r => `${r.companyId}:${r.pin || r.name}`)).size;
    $('#metric-payroll').textContent = money(pRows.reduce((a,r)=>a+Number(r.gross||0),0));
    $('#metric-paye').textContent = money(pRows.reduce((a,r)=>a+Number(r.paye||0),0));
    const out = invoices.filter(x=>x.direction==='sales').reduce((a,r)=>a+Number(r.vat||0),0), inp = invoices.filter(x=>x.direction==='purchases').reduce((a,r)=>a+Number(r.vat||0),0);
    $('#metric-vat').textContent = money(out-inp); $('#metric-employees').textContent = employees;
    const list = $('#activity-list');
    if (db.activities.length) list.innerHTML = db.activities.slice(0,5).map(a=>`<div class="activity-row"><span class="activity-icon ${a.kind}">${a.kind==='payroll'?'▤':a.kind==='vat'?'◍':'▦'}</span><span><strong>${esc(a.message)}</strong><small>${new Date(a.at).toLocaleString('en-KE',{dateStyle:'medium',timeStyle:'short'})}</small></span></div>`).join('');
  }
  function renderPayroll() {
    const records = periodRows(), p = payrollPeriod();
    $('#payroll-period-label').textContent = `${p.month} ${p.year} · ${db.companies.find(c=>c.id===p.companyId)?.name || 'Select a company'}`;
    $('#payroll-employees').textContent = new Set(records.map(r=>r.pin||r.name)).size;
    $('#payroll-gross').textContent = money(records.reduce((a,r)=>a+Number(r.gross||0),0));
    $('#payroll-paye').textContent = money(records.reduce((a,r)=>a+Number(r.paye||0),0));
    $('#payroll-employer').textContent = money(records.reduce((a,r)=>a+Number(r.employerNssf||0)+Number(r.employerAhl||0),0));
    $('#payroll-count').textContent = `${records.length} record${records.length===1?'':'s'}`;
    $('#payroll-rows').innerHTML = records.map(r=>`<tr><td><div class="person-cell"><span class="table-avatar">${esc((r.name||'?').split(/\s+/).map(x=>x[0]).join('').slice(0,2).toUpperCase())}</span><strong>${esc(r.name||'Unnamed employee')}</strong></div></td><td>${esc(r.pin||'—')}</td><td>${money(r.gross)}</td><td>${money(r.shif)}</td><td>${money(r.nssf)}</td><td>${money(r.ahl)}</td><td><strong>${money(r.paye)}</strong><small class="source-caption">${esc(r.payeSource||'CRM calculation')}</small></td><td><button class="row-delete" data-delete-payroll="${esc(r.id)}" aria-label="Delete payroll record">×</button></td></tr>`).join('');
    $('#payroll-empty').hidden = records.length > 0;
    $('#payroll-rows').closest('.table-wrap').hidden = !records.length;
  }
  function renderVat() {
    const records=periodInvoices(), p=vatPeriod();
    const company=db.companies.find(c=>c.id===p.companyId)?.name||'Select a company';
    $('#vat-period-label').textContent=`${p.month} ${p.year} · ${company}`;
    const all=db.invoices.filter(r=>r.companyId===p.companyId&&r.month===p.month&&Number(r.year)===p.year);
    const sales=all.filter(r=>r.direction==='sales'), purchases=all.filter(r=>r.direction==='purchases');
    const salesValue=sales.reduce((a,r)=>a+Number(r.taxable||0),0), output=sales.reduce((a,r)=>a+Number(r.vat||0),0), input=purchases.reduce((a,r)=>a+(r.taxType==='Exempt'?0:Number(r.vat||0)),0);
    $('#vat-sales').textContent=money(salesValue); $('#vat-output').textContent=money(output); $('#vat-input').textContent=money(input); $('#vat-net').textContent=money(output-input);
    $('#vat-count').textContent=`${records.length} invoice${records.length===1?'':'s'}`;
    $('#vat-rows').innerHTML=records.map(r=>`<tr><td>${esc(r.date)}</td><td><span class="type-pill ${r.direction}">${r.direction==='sales'?'Sale':'Purchase'}</span></td><td><strong>${esc(r.counterparty||'—')}</strong></td><td>${esc(r.pin||'—')}</td><td>${esc(r.invoiceNo||'—')}</td><td>${esc(r.taxType)} <small class="source-caption">${Math.round(r.rate*10000)/100}% · ${esc(r.rateRule)}</small></td><td>${money(r.taxable)}</td><td><strong>${money(r.vat)}</strong></td><td><button class="row-delete" data-delete-invoice="${esc(r.id)}" aria-label="Delete invoice">×</button></td></tr>`).join('');
    $('#vat-empty').hidden=records.length>0; $('#vat-rows').closest('.table-wrap').hidden=!records.length;
  }
  function renderCompanies() {
    $('#company-count').textContent=`${db.companies.length} compan${db.companies.length===1?'y':'ies'}`;
    $('#company-rows').innerHTML=db.companies.map(c=>{const rs=db.payroll.filter(r=>r.companyId===c.id), es=new Set(rs.map(r=>r.pin||r.name)).size;return `<tr><td><div class="person-cell"><span class="company-symbol">▦</span><strong>${esc(c.name)}</strong></div></td><td>${esc(c.pin||'—')}</td><td>${es}</td><td>${rs.length}</td><td>${new Date(c.createdAt).toLocaleDateString('en-KE',{day:'2-digit',month:'short',year:'numeric'})}</td><td><button class="row-delete" data-delete-company="${esc(c.id)}" aria-label="Delete company">×</button></td></tr>`}).join('');
    $('#company-empty').hidden=db.companies.length>0; $('#company-rows').closest('.table-wrap').hidden=!db.companies.length;
  }
  function renderP9() {
    const companyId=$('#p9-company').value, year=Number($('#p9-year').value||activeYear), employeeSelect=$('#p9-employee');
    const names=new Map(); db.payroll.filter(r=>r.companyId===companyId&&Number(r.year)===year).forEach(r=>names.set(r.pin||r.name,{name:r.name,pin:r.pin}));
    const old=employeeSelect.value; employeeSelect.innerHTML=[...names].map(([id,v])=>`<option value="${esc(id)}">${esc(v.name)}</option>`).join('');
    if([...employeeSelect.options].some(o=>o.value===old)) employeeSelect.value=old;else if(employeeSelect.options.length)employeeSelect.selectedIndex=0;
    const key=employeeSelect.value, rec=db.payroll.filter(r=>r.companyId===companyId&&Number(r.year)===year&&(r.pin||r.name)===key);
    const employee=names.get(key),company=db.companies.find(c=>c.id===companyId),model=p9Model(company,year,employee,rec);
    $('#p9-document').innerHTML=model?p9CardMarkup(model):'<div class="p9-empty"><strong>No payroll records for this company and year</strong><p>Add or import the employee payroll before preparing a P9 card.</p></div>';
    $('#p9-rule-chip').textContent=model?`Effective-dated PAYE schedules · ${model.months.filter(m=>m.gross).length} payroll months`:'Workbook-style P9A · effective rules by month';
    $('#p9-gross-total').textContent=money(model?.total.gross||0);$('#p9-chargeable-total').textContent=money(model?.total.chargeable||0);$('#p9-tax-total').textContent=money(model?.total.taxCharged||0);$('#p9-deductions-total').textContent=money(model?.total.deductions||0);$('#p9-paye-total').textContent=money(model?.total.paye||0);
    $('#print-p9').disabled=!model;$('#print-all-p9').disabled=!names.size;
  }
  function p9Model(company,year,employee,records) {
    if(!employee||!records.length)return null;
    const sum=(rows,key)=>rows.reduce((a,r)=>a+Number(r[key]||0),0);
    const fieldSum=(rows,source,fallback)=>rows.reduce((a,r)=>a+Number(r[source]??r[fallback]??0),0);
    const months=MONTHS.map(month=>{const rows=records.filter(r=>r.month===month);const gross=sum(rows,'gross'),nssf=sum(rows,'nssf'),ahl=sum(rows,'ahl'),shif=sum(rows,'shif'),prmf=sum(rows,'prmfDeduction'),interest=sum(rows,'mortgageDeduction');const pension30=gross*.30,fixedLimit=gross?30000:0,pension=Math.min(pension30,nssf,fixedLimit);return {month,basic:rows.reduce((a,r)=>a+Number(r.cash??Math.max(0,Number(r.gross||0)-Number(r.nonCash||0)-Number(r.meals||0))),0),nonCash:sum(rows,'nonCash'),meals:sum(rows,'meals'),gross,pension30,nssf,fixedLimit,ahl,shif,prmf,interest,deductions:pension+ahl+shif+prmf+interest,chargeable:fieldSum(rows,'importedTaxable','taxable'),taxCharged:fieldSum(rows,'importedTaxCharged','grossTax'),personalRelief:fieldSum(rows,'importedRelief','personalRelief'),insuranceRelief:sum(rows,'insuranceRelief'),paye:sum(rows,'paye'),ruleDates:[...new Set(rows.map(r=>r.rules?.paye).filter(Boolean))]};});
    const keys=['basic','nonCash','meals','gross','pension30','nssf','fixedLimit','ahl','shif','prmf','interest','deductions','chargeable','taxCharged','personalRelief','insuranceRelief','paye'];
    const total=Object.fromEntries(keys.map(k=>[k,sum(months,k)]));
    return {company,year,employee,months,total};
  }
  function p9Number(value) {return Number(value||0).toLocaleString('en-KE',{minimumFractionDigits:0,maximumFractionDigits:2});}
  function p9CardMarkup(model) {
    const m=model.months,t=model.total;
    const row=(values, label=false)=>`<tr>${values.map((v,i)=>i===0?`<th>${esc(v)}</th>`:`<td>${label?esc(v):p9Number(v)}</td>`).join('')}</tr>`;
    const monthly=m.map(x=>row([x.month,x.basic,x.nonCash,x.meals,x.gross,x.pension30,x.nssf,x.fixedLimit,x.ahl,x.shif,x.prmf,x.interest,x.deductions,x.chargeable,x.taxCharged,x.personalRelief,x.insuranceRelief,x.paye])).join('');
    const letters=['','A-','B-','C-','D-','E1 30%','E2 NSSF Actual','E3 Fixed Limit','F Amount','G Amount','H Amount','J Amount','K Total Kshs','L','', '', '', ''];
    const subheads=['','','','','','','','','','','','','','','','','',''];
    return `<div class="p9-topline"><span>P9A</span><div class="kra-heading"><div class="kra-mark" aria-hidden="true">KRA</div><div><strong>KENYA REVENUE<br>AUTHORITY</strong><small>TAX DEDUCTION CARD YEAR ${model.year}</small></div></div><span></span></div>
      <div class="p9-identity p9-identity-exact"><div><span>Employer's Name............</span><strong>${esc(model.company?.name||'')}</strong></div><div><span>Employer's PIN</span><strong>${esc(model.company?.pin||'')}</strong></div><div><span>Employee's Main Name:</span><strong>${esc(model.employee?.mainName||model.employee?.name||'')}</strong></div><div><span>Employee's PIN</span><strong>${esc(model.employee?.pin||'')}</strong></div><div><span>Employee's Other Name:</span><strong>${esc(model.employee?.otherName||'')}</strong></div><div></div></div>
      <div class="table-wrap p9-table-wrap"><table class="p9-table"><thead><tr><th rowspan="2">MONTH</th><th rowspan="2">Basic Salary</th><th rowspan="2">Benefits-<br>Non-Cash</th><th rowspan="2">Value of<br>Meals</th><th rowspan="2">Total Gross<br>Pay</th><th colspan="3">Defined Contribution Retirement Scheme / NSSF</th><th rowspan="2">Affordable Housing<br>Levy (AHL)</th><th rowspan="2">Social Health<br>Insurance Fund (SHIF)</th><th rowspan="2">Post Retirement<br>Medical Fund (PRMF)</th><th rowspan="2">Owner-Occupied<br>Interest</th><th rowspan="2">Total<br>Deductions</th><th rowspan="2">Chargeable<br>Pay</th><th rowspan="2">Tax<br>Charged</th><th rowspan="2">Personal<br>Relief</th><th rowspan="2">Insurance<br>Relief</th><th rowspan="2">PAYE Tax</th></tr><tr><th>E1 30%<br>of Gross</th><th>E2 NSSF<br>Actual</th><th>E3 Fixed<br>Limit</th></tr></thead><tbody>${monthly}</tbody><tfoot>${row(['TOTAL',t.basic,t.nonCash,t.meals,t.gross,t.pension30,t.nssf,t.fixedLimit,t.ahl,t.shif,t.prmf,t.interest,t.deductions,t.chargeable,t.taxCharged,t.personalRelief,t.insuranceRelief,t.paye])}</tfoot></table></div>
      <div class="p9-year-end"><div><strong>To be completed by Employer at end of year</strong><b>TOTAL CHARGEABLE PAY (COL. O) &nbsp; ${p9Number(t.chargeable)}</b></div><div><strong>TOTAL TAX (COL. S) Kshs. &nbsp; ${p9Number(t.paye)}</strong></div></div>
      <div class="p9-legal"><div><strong>IMPORTANT</strong><p><b>1. Use P9A</b><br>(a) For all liable employees<br>(b) Where an employee is eligible to tax relief<br>(c) Allowable interest is subject to the applicable limit.</p><small>(See back of this card for further information)</small></div><div><p>(b) Attach photocopy of interest certificate and statement of account from the Financial Institution.</p><strong>(ii) THE DECLARATION</strong><p>Names of Financial Institution: ${esc(model.employee?.financialInstitution||'N/A')}</p><p>L.R. No. of owner occupied property: ${esc(model.employee?.propertyNumber||'N/A')}</p><p>Date of occupation: ${esc(model.employee?.occupationDate||'N/A')}</p></div></div>`;
  }
  function p9BatchModels() {
    const companyId=$('#p9-company').value,year=Number($('#p9-year').value||activeYear),keys=new Map();
    db.payroll.filter(r=>r.companyId===companyId&&Number(r.year)===year).forEach(r=>keys.set(r.pin||r.name,{name:r.name,pin:r.pin}));
    const company=db.companies.find(c=>c.id===companyId);
    return [...keys].map(([key,employee])=>p9Model(company,year,employee,db.payroll.filter(r=>r.companyId===companyId&&Number(r.year)===year&&(r.pin||r.name)===key))).filter(Boolean);
  }
  function printAllP9() {
    const models=p9BatchModels();if(!models.length){toast('No employees have payroll records for this company and tax year.');return;}
    const host=document.createElement('div');host.id='p9-batch-print';host.innerHTML=models.map((m,i)=>`<article class="p9-document p9-print-page" data-employee="${esc(m.employee?.name||'')}">${p9CardMarkup(m)}</article>`).join('');document.body.append(host);document.body.classList.add('printing-p9-batch');
    const cleanup=()=>{host.remove();document.body.classList.remove('printing-p9-batch');window.removeEventListener('afterprint',cleanup);};window.addEventListener('afterprint',cleanup,{once:true});window.print();setTimeout(cleanup,60000);
  }
  function renderAll() {
    companyOptions($('#payroll-company'), $('#payroll-company')?.value);
    companyOptions($('#vat-company'), $('#vat-company')?.value);
    companyOptions($('#p9-company'), $('#p9-company')?.value);
    $('#payroll-nav-count').textContent=db.payroll.length;
    renderOverview(); renderPayroll(); renderVat(); renderCompanies(); renderP9();
  }
  function showView(view) {
    activeView=view;
    $$('.view').forEach(x=>x.classList.toggle('active',x.id===`view-${view}`));
    $$('.nav-item').forEach(x=>x.classList.toggle('active',x.dataset.view===view));
    $('#crumb-title').textContent=({overview:'Overview',payroll:'Payroll',p9:'P9 forms',vat:'VAT analysis',companies:'Companies',rules:'Tax rules'})[view]||'Overview';
    $('#sidebar').classList.remove('mobile-open');
    if(location.hash!==`#${view}`) history.replaceState(null,'',`#${view}`);
    if(view==='p9') renderP9();
  }
  const taxNews = [
    {date:'1 Jul 2026', tag:'FINANCE ACT 2026', title:'Finance Act 2026 provisions take effect', summary:'KRA highlights changes affecting VAT treatment, bad-debt refund periods, and employer payroll records. Review applicability and effective dates before changing a return.', source:'KRA · Finance Act 2026 guide', url:'https://www.kra.go.ke/popular-links/finance-act-2026-what-it-means-for-you'},
    {date:'2026', tag:'VAT · PETROLEUM', title:'Petroleum VAT rate orders published', summary:'Kenya Law lists 2026 VAT rate orders. CRM keeps the supplied effective-date schedule: 13% on 15 Apr 2026 and 8% for qualifying petroleum from 16 Apr 2026 through 14 Jan 2027; confirm product eligibility against the gazetted order.', source:'Kenya Law · VAT rate orders', url:'https://new.kenyalaw.org/legislation/?page=10'},
    {date:'29 Apr 2026', tag:'DRAFT · INCOME TAX', title:'KRA published draft income-tax regulations', summary:'Draft residential rental-income and graduate-apprenticeship rebate regulations were published for consultation. Draft proposals are not treated as enacted rules in CRM calculations.', source:'KRA · Public notices', url:'https://www.kra.go.ke/news-center/public-notices'},
    {date:'Current KRA guidance', tag:'PAYE · PAYROLL', title:'PAYE bands and monthly remittance guidance', summary:'KRA guidance lists individual tax bands, resident personal relief, and the 9th-of-the-following-month PAYE filing and payment deadline. Apply the effective period relevant to each payroll month.', source:'KRA · PAYE guidance', url:'https://www.kra.go.ke/individual/filing-paying/types-of-taxes/paye'}
  ];
  function renderTaxNews() {
    const host=$('#tax-news-feed');
    host.innerHTML=taxNews.map(n=>`<article class="news-item"><div class="news-meta"><span class="news-tag">${esc(n.tag)}</span><time>${esc(n.date)}</time></div><h3>${esc(n.title)}</h3><p>${esc(n.summary)}</p><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.source)} <span>↗</span></a></article>`).join('');
  }
  const accounts = () => { try { return JSON.parse(localStorage.getItem(ACCOUNTS_KEY)||'[]'); } catch { return []; } };
  function setAuthMode(mode) {
    const signup=mode==='signup';
    $('#auth-name-wrap').hidden=!signup; $('#auth-confirm-wrap').hidden=!signup; $('#auth-options').hidden=signup;
    $('#auth-eyebrow').textContent=signup?'GET STARTED':'WELCOME BACK';
    $('#auth-title').textContent=signup?'Create your CRM account':'Sign in to CRM';
    $('#auth-description').textContent=cloudReady()?'Create or access your CRM workspace across devices.':signup?'Create a private workspace on this browser.':'Use your local workspace account to continue.';
    $('#auth-submit').innerHTML=signup?'Create account <span>→</span>':'Sign in <span>→</span>';
    $('#auth-password').autocomplete=signup?'new-password':'current-password';
    $$('.auth-tab').forEach(b=>b.classList.toggle('active',b.dataset.authMode===mode));
    $('#auth-error').textContent=''; $('#auth-form').dataset.mode=mode;
  }
  function openAuth(mode='signin') { $('#app-shell').hidden=true; $('#auth-page').hidden=false; setAuthMode(mode); }
  function showWorkspace(account) {
    activeAccount={email:account.email,name:account.name}; db=loadWorkspace(account.email);
    $('#profile-name').textContent=account.name; $('#profile-email').textContent=account.email;
    $('#profile-avatar').textContent=account.name.split(/\s+/).map(x=>x[0]).slice(0,2).join('').toUpperCase();
    $('#auth-page').hidden=true; $('#app-shell').hidden=false;
    showView(location.hash.slice(1)||'overview'); renderAll(); renderTaxNews();
  }
  function showCloudWorkspace(user) {
    const name=user.user_metadata?.full_name||user.email.split('@')[0];
    activeAccount={email:user.email,name};
    $('#profile-name').textContent=name; $('#profile-email').textContent=user.email;
    $('#profile-avatar').textContent=name.split(/\s+/).map(x=>x[0]).slice(0,2).join('').toUpperCase();
    $('#auth-page').hidden=true; $('#app-shell').hidden=false;
    showView(location.hash.slice(1)||'overview'); renderAll(); renderTaxNews();
  }
  function bytesToBase64(bytes) { let binary=''; bytes.forEach(b=>binary+=String.fromCharCode(b)); return btoa(binary); }
  function base64ToBytes(value) { return Uint8Array.from(atob(value),c=>c.charCodeAt(0)); }
  async function passwordHash(password,salt) {
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
    const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:150000,hash:'SHA-256'},key,256);
    return bytesToBase64(new Uint8Array(bits));
  }
  function initAuth() {
    const note=$('#auth-storage-note');
    if(cloudReady()) note.innerHTML='<strong>Supabase cloud workspace</strong><br>Sign in on another device to load your saved workspace. Existing local records require your confirmation before upload.';
    else note.innerHTML='<strong>Browser-only account</strong><br>Cloud sign-in is not connected yet. Records remain on this device until Supabase is configured.';
    if(cloudReady()) { cloudClient.auth.getSession().then(async({data,error})=>{
      if(error||!data.session)return;
      try{await loadCloudWorkspace(data.session.user);showCloudWorkspace(data.session.user);}
      catch(e){cloudUserId=null;$('#auth-error').textContent=`Could not load the cloud workspace: ${e.message}`;openAuth();}
    }); return; }
    const email=sessionStorage.getItem(SESSION_KEY)||localStorage.getItem(SESSION_KEY);
    const account=accounts().find(a=>a.email===email);
    if(account) showWorkspace(account); else { sessionStorage.removeItem(SESSION_KEY); localStorage.removeItem(SESSION_KEY); openAuth(); }
  }
  function appendAssistantMessage(text, who) {
    const host=$('#assistant-messages'), item=document.createElement('div'); item.className=who==='assistant'?'assistant-message':'assistant-message user-message';
    if(who==='assistant') { const avatar=document.createElement('span'); avatar.className='assistant-avatar'; avatar.textContent='✳'; item.append(avatar); }
    const body=document.createElement('div'), label=document.createElement('strong'), content=document.createElement('p');
    label.textContent=who==='assistant'?'CRM Assistant':'You'; content.textContent=text; body.append(label,content);
    if(who==='assistant'){const small=document.createElement('small');small.textContent='Based on this browser’s saved data and configured rules';body.append(small);}
    item.append(body);host.append(item);host.scrollTop=host.scrollHeight;
  }
  function assistantAnswer(question) {
    const q=question.toLowerCase(), month=activeMonth, year=activeYear;
    if(/news|update|regulation|change|notice/.test(q)) return 'The dashboard has a dated tax update digest with links to KRA and Kenya Law. This static preview does not fetch live notices or automatically change tax rules. Rule updates need an official source, verified scope and effective date, then a reviewed release.';
    if(/rule|paye|nssf|shif|housing levy|ahl|tax band/.test(q)) return `Configured payroll rules for ${month} ${year}: PAYE bands are 10%, 25%, 30%, 32.5%, and 35%, with KES 2,400 monthly personal relief for residents. SHIF uses 2.75% with a KES 300 minimum; AHL is 1.5% each for employee and employer. NSSF limits and each rule are selected by the payroll period’s effective date. Check Tax rules for the dated schedules.`;
    if(/vat/.test(q)) { const rows=db.invoices.filter(x=>x.month===month&&Number(x.year)===year), sales=rows.filter(x=>x.direction==='sales').reduce((a,x)=>a+Number(x.vat||0),0), purchases=rows.filter(x=>x.direction==='purchases'&&!/exempt/i.test(x.taxType||'')).reduce((a,x)=>a+Number(x.vat||0),0);return rows.length?`${month} ${year}: output VAT is ${money(sales)} and recorded non-exempt input VAT is ${money(purchases)}. Net position before other credits is ${money(sales-purchases)}. The recorded invoices may not include all adjustments or carry-forwards.`:`There are no VAT invoices saved for ${month} ${year}. Add or import invoices to calculate the period position.`; }
    if(/p9|employee/.test(q)) { const count=new Set(db.payroll.filter(x=>Number(x.year)===year).map(x=>x.pin||x.name)).size;return `${count} employees have payroll records for ${year}. Open P9 forms to select a company and employee, then review the annual figures.`; }
    if(/payroll|salary|gross|deduction/.test(q)) { const rows=db.payroll.filter(x=>x.month===month&&Number(x.year)===year), sum=k=>rows.reduce((a,x)=>a+Number(x[k]||0),0);return rows.length?`${month} ${year} payroll: ${rows.length} employee records; gross pay ${money(sum('gross'))}; PAYE ${money(sum('paye'))}; NSSF ${money(sum('nssf'))}; SHIF ${money(sum('shif'))}; AHL ${money(sum('ahl'))}.`:`No payroll records are saved for ${month} ${year}. Add a company, then record or import payroll.`; }
    if(/compan|business/.test(q)) return `There ${db.companies.length===1?'is':'are'} ${db.companies.length} compan${db.companies.length===1?'y':'ies'} in this browser workspace.`;
    return 'I can summarize saved payroll, P9 and VAT records, and explain the configured Kenya tax schedules. Try asking for a payroll summary, VAT position, P9 employee count, or current tax rules.';
  }
  function toast(message) { const t=$('#toast');t.textContent=message;t.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>t.classList.remove('show'),2800); }
  function field(name,label,type='text',opts={}) {
    if(type==='select') return `<label>${label}<select name="${name}" ${opts.required===false?'':'required'}>${opts.options.map(o=>`<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select></label>`;
    return `<label>${label}<input name="${name}" type="${type}" ${opts.required===false?'':'required'} ${opts.value!==undefined?`value="${esc(opts.value)}"`:''} ${opts.step?'step="'+opts.step+'"':''} ${opts.min!==undefined?'min="'+opts.min+'"':''} ${opts.placeholder?`placeholder="${esc(opts.placeholder)}"`:''}></label>`;
  }
  function openModal(mode) {
    modalMode=mode; const fields=$('#modal-fields'); let title='Add record', eyebrow='CRM · Workspace', button='Save record', html='';
    if(mode==='company') {title='Add a company';eyebrow='SETUP · COMPANIES';button='Save company';html=field('name','Company name','text',{placeholder:'e.g. Acme Kenya Limited'})+field('pin','Company PIN','text',{placeholder:'P051234567X'});}
    if(mode==='payroll') {
      if(!db.companies.length){toast('Add a company before recording payroll.');showView('companies');return;}
      title='Add payroll record';eyebrow='PAYROLL · EMPLOYEE';button='Calculate & save';
      html=field('companyId','Company','select',{options:db.companies.map(c=>({value:c.id,label:c.name}))})+field('month','Payroll month','select',{options:MONTHS.map(x=>({value:x,label:x}))})+field('year','Tax year','number',{value:activeYear,min:2023})+field('name','Employee name')+field('pin','Employee KRA PIN','text',{placeholder:'A000000000X'})+field('residential','Tax residency','select',{options:[{value:'Resident',label:'Resident'},{value:'Non-resident',label:'Non-resident'}]})+field('cash','Cash salary / NSSF pensionable pay','number',{value:0,min:0,step:'0.01'})+field('nonCash','Taxable non-cash benefits','number',{value:0,min:0,step:'0.01'})+field('meals','Taxable meals & other benefits','number',{value:0,min:0,step:'0.01'})+field('registeredPension','Additional registered pension / provident contribution','number',{value:0,min:0,step:'0.01'})+field('prmf','Post-retirement medical fund contribution (max KES 15,000)','number',{value:0,min:0,step:'0.01'})+field('mortgageInterest','Qualifying mortgage interest (max KES 30,000)','number',{value:0,min:0,step:'0.01'})+field('insurancePremiums','Qualifying insurance premiums (relief is 15%, capped at KES 5,000)','number',{value:0,min:0,step:'0.01'});
    }
    if(mode==='vat') {
      if(!db.companies.length){toast('Add a company before recording an invoice.');showView('companies');return;}
      title='Add VAT invoice';eyebrow='VAT · INVOICE REGISTER';button='Save invoice';
      title='Add VAT invoice';eyebrow='VAT · INVOICE REGISTER';button='Save invoice';
      html=field('companyId','Company','select',{options:db.companies.map(c=>({value:c.id,label:c.name}))})+field('direction','Transaction','select',{options:[{value:'sales',label:'Sales / output VAT'},{value:'purchases',label:'Purchases / input VAT'}]})+field('date','Invoice date','date',{value:new Date().toISOString().slice(0,10)})+field('counterparty','Supplier or customer')+field('pin','Supplier / customer PIN','text',{required:false,placeholder:'Optional'})+field('invoiceNo','Invoice number','text',{placeholder:'Invoice reference'})+field('description','Description','text',{required:false,placeholder:'Goods or services'})+field('taxType','Tax type','select',{options:[{value:'VAT',label:'Standard VAT'},{value:'Fuel',label:'Fuel / petroleum (historical generic category)'},{value:'Premium motor spirit',label:'Premium motor spirit (petrol)'},{value:'Illuminating kerosene',label:'Illuminating kerosene'},{value:'Automotive gas oil',label:'Automotive gas oil (diesel)'},{value:'Other petroleum',label:'Other petroleum product'},{value:'Zero-rated',label:'Zero-rated'},{value:'Exempt',label:'Exempt'}]})+field('taxable','Taxable value (KES)','number',{value:0,min:0,step:'0.01'});
    }
    $('#modal-title').textContent=title;$('#modal-eyebrow').textContent=eyebrow;$('#modal-submit').textContent=button;fields.innerHTML=html;
    const b=$('#modal-backdrop');b.hidden=false;document.body.classList.add('modal-open');$('#form-message').textContent='';$('#modal-fields input, #modal-fields select')?.focus();
  }
  function closeModal() {$('#modal-backdrop').hidden=true;document.body.classList.remove('modal-open');$('#modal-form').reset();}
  $('#modal-form').addEventListener('submit', e => {
    e.preventDefault(); const data=Object.fromEntries(new FormData(e.currentTarget).entries());
    if(modalMode==='company') {
      if(db.companies.some(c=>c.pin&&c.pin.toLowerCase()===data.pin.toLowerCase())) {$('#form-message').textContent='A company with this PIN already exists.';return;}
      db.companies.push({id:crypto.randomUUID(),name:data.name.trim(),pin:data.pin.trim().toUpperCase(),createdAt:new Date().toISOString()});addActivity(`Added company ${data.name}`,'company');save();closeModal();toast('Company added.');return;
    }
    if(modalMode==='payroll') {
      const gross=Number(data.cash||0)+Number(data.nonCash||0)+Number(data.meals||0);
      const raw={...data,year:Number(data.year),cash:Number(data.cash),gross,nonCash:Number(data.nonCash),meals:Number(data.meals),month:data.month,createdAt:new Date().toISOString()};
      const record=taxRecord(raw);db.payroll.push(record);addActivity(`Saved payroll for ${data.name} · ${data.month} ${data.year}`,'payroll');save();closeModal();toast('Payroll calculated and saved.');return;
    }
    if(modalMode==='vat') {
      const date=data.date, when=new Date(`${date}T00:00:00`), schedule=vatRate(data.taxType,date), taxable=Number(data.taxable||0), month=MONTHS[when.getMonth()],year=when.getFullYear();
      const inv={...data,id:crypto.randomUUID(),month,year,taxable,rate:schedule.rate,rateRule:schedule.rule,vat:taxable*schedule.rate,total:taxable*(1+schedule.rate),createdAt:new Date().toISOString()};
      db.invoices.push(inv);addActivity(`Recorded ${data.direction==='sales'?'sales':'purchase'} invoice ${data.invoiceNo}`,'vat');save();closeModal();toast('Invoice saved with the rate for its date.');
    }
  });

  function parseCsv(text) {
    const rows=[];let row=[],cell='',quoted=false;
    for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'&&text[i+1]==='"'){cell+='"';i++;}else if(c==='"')quoted=false;else cell+=c;}else if(c==='"')quoted=true;else if(c===','){row.push(cell);cell='';}else if(c==='\n'){row.push(cell.replace(/\r$/,''));if(row.some(v=>v.trim()))rows.push(row);row=[];cell='';}else cell+=c;}
    if(cell.length||row.length){row.push(cell.replace(/\r$/,''));if(row.some(v=>v.trim()))rows.push(row);}return rows;
  }
  function parseInvoiceDate(value) {
    const raw=String(value||'').trim();
    const serial=Number(raw);
    if(/^\d{5}(?:\.\d+)?$/.test(raw) && serial>10000 && serial<100000) return new Date(Date.UTC(1899,11,30)+Math.floor(serial)*86400000);
    const iso=raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if(iso) return new Date(Number(iso[1]),Number(iso[2])-1,Number(iso[3]));
    const dmy=raw.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
    if(dmy) return new Date(Number(dmy[3]),Number(dmy[2])-1,Number(dmy[1]));
    const parsed=new Date(raw);
    return Number.isNaN(parsed.getTime())?null:parsed;
  }
  async function importPayroll(file) {
    if(!db.companies.length){toast('Add a company before importing payroll.');showView('companies');return;}
    const rows=parseCsv(await file.text()); if(!rows.length){toast('The selected file is empty.');return;}
    const norm=v=>String(v||'').replace(/^\uFEFF/,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
    const headerAt=rows.slice(0,30).findIndex(row=>{const h=row.map(norm);return h.some(x=>x==='pin'||x.includes('pin of employee'))&&h.some(x=>x==='employee'||x.includes('name of the employee')||x.includes('employee name'));});
    const hasHeaders=headerAt>=0, headers=hasHeaders?rows[headerAt].map(norm):[];
    const body=hasHeaders?rows.slice(headerAt+1):rows;const idx=(aliases,fallback=-1)=>{const i=headers.findIndex(h=>aliases.some(a=>h===a||h.includes(a)));return i>=0?i:fallback;};
    const cols={pin:idx(['pin of employee','employee pin','pin'],0),name:idx(['name of the employee','employee name','employee'],1),residential:idx(['residential status'],2),cash:idx(['total cash pay','cash pay'],4),nonCash:idx(['total non cash pay','non cash pay'],5),meals:idx(['value of meals','meals'],6),housing:idx(['net value of housing','housing'],7),gross:idx(['total gross pay','gross pay'],8),taxable:idx(['taxable pay'],10),taxPayable:idx(['tax payable'],11),monthlyRelief:idx(['monthly relief','personal relief'],-1),paye:idx(['paye tax','paye'],12),selfAssessed:idx(['self assessed paye'],13),nssf:idx(['nssf'],-1),shif:idx(['shif'],-1),ahl:idx(['housing levy','ahl'],-1),month:idx(['payroll month','month'],-1),year:idx(['tax year','year'],-1)};
    const meta=rows.slice(0,Math.max(0,headerAt)).flat().map(norm);let metaMonth='',metaYear=0;
    for(let i=0;i<meta.length-1;i++){if(meta[i]==='month'&&MONTHS.some(m=>m.toLowerCase()===meta[i+1]))metaMonth=MONTHS.find(m=>m.toLowerCase()===meta[i+1].toLowerCase());if(meta[i]==='year'&&/^20\d{2}$/.test(meta[i+1]))metaYear=Number(meta[i+1]);}
    let fallbackMonth=metaMonth||$('#payroll-month').value||activeMonth, fallbackYear=metaYear||Number($('#payroll-year').value||activeYear);
    if(MONTHS.includes(fallbackMonth))$('#payroll-month').value=fallbackMonth;if($('#payroll-year').querySelector(`option[value="${fallbackYear}"]`))$('#payroll-year').value=fallbackYear;
    const companyId=$('#payroll-company').value||db.companies[0].id;let count=0,skipped=0;
    const n=(row,i)=>i<0?0:Number(String(row[i]||'').replace(/[^0-9.-]/g,''))||0;
    for(const cells of body){const name=String(cells[cols.name]||'').trim();if(!name||/^name of (the )?employee$/i.test(name)){skipped++;continue;}
      const month=cols.month>=0&&MONTHS.some(m=>m.toLowerCase()===String(cells[cols.month]).trim().toLowerCase())?MONTHS.find(m=>m.toLowerCase()===String(cells[cols.month]).trim().toLowerCase()):fallbackMonth;
      const year=cols.year>=0&&Number(cells[cols.year])?Number(cells[cols.year]):fallbackYear;
      const gross=n(cells,cols.gross)||n(cells,cols.cash)+n(cells,cols.nonCash)+n(cells,cols.meals)+n(cells,cols.housing);
      const raw={companyId,month,year,pin:String(cells[cols.pin]||'').trim(),name,residential:String(cells[cols.residential]||'Resident').trim(),cash:cols.cash>=0?n(cells,cols.cash):gross,nonCash:n(cells,cols.nonCash),meals:n(cells,cols.meals),gross,taxableInput:n(cells,cols.taxable),sourceTaxCharged:n(cells,cols.taxPayable),sourceRelief:n(cells,cols.monthlyRelief),sourcePAYE:n(cells,cols.paye>=0?cols.paye:cols.selfAssessed),createdAt:new Date().toISOString()};
      const r=taxRecord(raw);if(cols.paye>=0||cols.selfAssessed>=0){r.paye=raw.sourcePAYE;r.payeSource='Imported iTax value';}if(cols.nssf>=0)r.nssf=n(cells,cols.nssf);if(cols.shif>=0)r.shif=n(cells,cols.shif);if(cols.ahl>=0)r.ahl=n(cells,cols.ahl);r.importedTaxable=raw.taxableInput;r.importedTaxCharged=raw.sourceTaxCharged;r.importedRelief=raw.sourceRelief;db.payroll.push(r);count++;
    }
    if(!count){toast(`No payroll rows imported. Check the employee-name, PIN, and payroll columns in ${file.name}.`);$('#payroll-file').value='';return;}
    addActivity(`Imported ${count} payroll record${count===1?'':'s'} · ${fallbackMonth} ${fallbackYear}`,'payroll');save();toast(`${count} payroll records imported${skipped?` · ${skipped} rows skipped`:''}.`);$('#payroll-file').value='';
  }
  async function importVat(file) {
    if(!db.companies.length){toast('Add a company before importing VAT invoices.');showView('companies');return;}
    const rows=parseCsv(await file.text());if(!rows.length){toast('The selected file is empty.');return;}
    const norm=v=>String(v||'').replace(/^\uFEFF/,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
    const headerAt=rows.slice(0,30).findIndex(row=>{const h=row.map(norm);return h.some(x=>x==='invoice date'||x==='date')&&h.some(x=>x.includes('invoice number')||x==='invoice no'||x==='invoice number no')&&h.some(x=>x.includes('taxable value')||x==='taxable');});
    if(headerAt<0){toast(`Could not find invoice date, invoice number, and taxable value columns in ${file.name}. Export the invoice table to CSV and try again.`);$('#vat-file').value='';return;}
    const headers=rows[headerAt].map(norm),idx=(aliases)=>headers.findIndex(h=>aliases.some(a=>h===a||h.includes(a)));
    const c={pin:idx(['pin of supplier','pin of purchaser','supplier pin','customer pin','pin']),name:idx(['name of supplier','name of purchaser','supplier name','customer name','counterparty']),date:idx(['invoice date','date']),no:idx(['invoice number','invoice no']),description:idx(['description']),taxable:idx(['taxable value','taxable']),vat:idx(['amount of vat','vat amount','vat']),taxType:idx(['tax type']),direction:idx(['transaction type','direction','type'])};
    const body=rows.slice(headerAt+1), preamble=rows.slice(0,headerAt).flat().join(' ');const hasDirection=c.direction>=0;
    const autoDir=preamble.match(/(?:data for|loaded type)\s*:?\s*(sales|purchase|purchases)/i)?.[1]||'';
    const selectedDirection=$('#vat-import-direction').value;
    const chosenDirection=autoDir?(autoDir.toLowerCase().startsWith('purchase')?'purchases':'sales'):selectedDirection;
    if(!hasDirection&&!chosenDirection){toast('Choose Sales or Purchases in “Import as” when the CSV does not include a transaction type.');$('#vat-file').value='';return;}
    const companyId=$('#vat-company').value||db.companies[0].id;let count=0,skipped=0,duplicates=0;
    const n=(v)=>Number(String(v||'').replace(/[^0-9.-]/g,''))||0;
    const forcedType=$('#vat-import-tax-type').value;
    for(const row of body){if(!row[c.date]||!row[c.no]){skipped++;continue;}const when=parseInvoiceDate(row[c.date]);if(!when){skipped++;continue;}
      const dateKey=`${when.getFullYear()}-${String(when.getMonth()+1).padStart(2,'0')}-${String(when.getDate()).padStart(2,'0')}`;
      const direction=hasDirection?(/purchase|input/i.test(row[c.direction]||'')?'purchases':'sales'):chosenDirection;
      const taxType=forcedType||row[c.taxType]||'VAT';const schedule=vatRate(taxType,dateKey);const taxable=n(row[c.taxable]);const vatText=String(row[c.vat]??'').trim();const amt=vatText===''?taxable*schedule.rate:n(vatText);
      const invoiceNo=String(row[c.no]||'').trim();if(db.invoices.some(x=>x.companyId===companyId&&x.direction===direction&&x.invoiceNo===invoiceNo&&x.date===dateKey)){duplicates++;continue;}
      db.invoices.push({id:crypto.randomUUID(),companyId,direction,date:dateKey,month:MONTHS[when.getMonth()],year:when.getFullYear(),pin:c.pin>=0?row[c.pin]||'':'',counterparty:c.name>=0?row[c.name]||'':'',invoiceNo,description:c.description>=0?row[c.description]||'':'',taxType,rate:schedule.rate,rateRule:schedule.rule,taxable,vat:amt,total:taxable+amt,createdAt:new Date().toISOString()});count++;
    }
    if(!count){toast(`No new VAT invoices imported. ${duplicates?`${duplicates} duplicate${duplicates===1?' was':'s were'} skipped. `:''}Check invoice dates and invoice numbers in ${file.name}.`);$('#vat-file').value='';return;}
    addActivity(`Imported ${count} VAT invoices`,'vat');save();toast(`${count} VAT invoices imported${duplicates?` · ${duplicates} duplicates skipped`:''}.`);$('#vat-file').value='';
  }
  function downloadCsv(filename, rows) {
    const csv=rows.map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\r\n');const blob=new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=filename;a.click();URL.revokeObjectURL(a.href);
  }
  function csvPayroll() {downloadCsv('CRM-payroll.csv',[['PIN','Employee','Month','Year','Gross pay','NSSF','SHIF','AHL','Taxable pay','PAYE'],...periodRows().map(r=>[r.pin,r.name,r.month,r.year,r.gross,r.nssf,r.shif,r.ahl,r.taxable,r.paye])]);}
  function csvVat() {downloadCsv('CRM-vat-invoices.csv',[['Date','Direction','Counterparty','PIN','Invoice number','Tax type','Tax rate','Taxable value','VAT'],...periodInvoices().map(r=>[r.date,r.direction,r.counterparty,r.pin,r.invoiceNo,r.taxType,r.rate,r.taxable,r.vat])]);}

  document.addEventListener('click', e => {
    const view=e.target.closest('[data-view]');if(view){showView(view.dataset.view);return;}
    const action=e.target.closest('[data-action]')?.dataset.action;
    if(action==='open-company')openModal('company');if(action==='open-payroll'||action==='quick-payroll'){if(action==='quick-payroll'&&!db.companies.length){showView('companies');toast('Set up a company to get started.');}else{showView('payroll');openModal('payroll');}}if(action==='open-vat')openModal('vat');
    const delP=e.target.closest('[data-delete-payroll]')?.dataset.deletePayroll;if(delP){db.payroll=db.payroll.filter(r=>r.id!==delP);save();toast('Payroll record removed.');}
    const delI=e.target.closest('[data-delete-invoice]')?.dataset.deleteInvoice;if(delI){db.invoices=db.invoices.filter(r=>r.id!==delI);save();toast('Invoice removed.');}
    const delC=e.target.closest('[data-delete-company]')?.dataset.deleteCompany;if(delC){if(db.payroll.some(r=>r.companyId===delC)||db.invoices.some(r=>r.companyId===delC)){toast('Remove this company’s payroll and invoices first.');return;}db.companies=db.companies.filter(c=>c.id!==delC);save();toast('Company removed.');}
  });
  ['payroll-company','payroll-month','payroll-year'].forEach(id=>$('#'+id).addEventListener('change',renderPayroll));
  ['vat-company','vat-month','vat-year','vat-type'].forEach(id=>$('#'+id).addEventListener('change',renderVat));
  ['p9-company','p9-year','p9-employee'].forEach(id=>$('#'+id).addEventListener('change',renderP9));
  $('#modal-close').addEventListener('click',closeModal);$('#modal-cancel').addEventListener('click',closeModal);$('#modal-backdrop').addEventListener('click',e=>{if(e.target.id==='modal-backdrop')closeModal();});
  $('#mobile-menu').addEventListener('click',()=>$('#sidebar').classList.toggle('mobile-open'));
  $('#payroll-file').addEventListener('change',e=>e.target.files[0]&&importPayroll(e.target.files[0]));$('#vat-file').addEventListener('change',e=>e.target.files[0]&&importVat(e.target.files[0]));
  $('#payroll-export').addEventListener('click',csvPayroll);$('#vat-export').addEventListener('click',csvVat);$('#print-p9').addEventListener('click',()=>window.print());$('#print-all-p9').addEventListener('click',printAllP9);
  $$('.auth-tab').forEach(button=>button.addEventListener('click',()=>setAuthMode(button.dataset.authMode)));
  $('#show-password').addEventListener('click',()=>{const input=$('#auth-password'),show=input.type==='password';input.type=show?'text':'password';$('#show-password').textContent=show?'Hide':'Show';});
  $('#forgot-password').addEventListener('click',()=>{$('#auth-error').textContent='Password recovery needs an email service. This local preview cannot reset account passwords.';});
  $('#logout-button').addEventListener('click',async()=>{if(cloudReady())await cloudClient.auth.signOut();cloudUserId=null;activeAccount=null;db={...emptyState};sessionStorage.removeItem(SESSION_KEY);localStorage.removeItem(SESSION_KEY);openAuth('signin');});
  $('#auth-form').addEventListener('submit',async e=>{
    e.preventDefault(); const mode=e.currentTarget.dataset.mode, email=$('#auth-email').value.trim().toLowerCase(), password=$('#auth-password').value, error=$('#auth-error'); error.textContent='';
    try {
      if(cloudReady()) {
        let user, authError;
        if(mode==='signup') {
          const name=$('#auth-name').value.trim(),confirm=$('#auth-confirm').value;
          if(!name){error.textContent='Enter your name.';return;}
          if(password.length<8){error.textContent='Use a password with at least 8 characters.';return;}
          if(password!==confirm){error.textContent='The passwords do not match.';return;}
          ({data:{user},error:authError}=await cloudClient.auth.signUp({email,password,options:{data:{full_name:name},emailRedirectTo:location.href.split('#')[0]}}));
          if(authError)throw authError;
          if(!user||!user.id){error.textContent='Check your email to confirm the new account, then sign in.';return;}
        } else {
          ({data:{user},error:authError}=await cloudClient.auth.signInWithPassword({email,password}));
          if(authError)throw authError;
        }
        await loadCloudWorkspace(user);showCloudWorkspace(user);return;
      }
      if(!crypto.subtle) throw new Error('Password security is unavailable in this browser context. Open CRM through localhost or a secure HTTPS site.');
      let list=accounts();
      if(mode==='signup') {
        const name=$('#auth-name').value.trim(), confirm=$('#auth-confirm').value;
        if(!name){error.textContent='Enter your name.';return;}
        if(password.length<8){error.textContent='Use a password with at least 8 characters.';return;}
        if(password!==confirm){error.textContent='The passwords do not match.';return;}
        if(list.some(a=>a.email===email)){error.textContent='An account with this email already exists on this browser.';return;}
        const salt=crypto.getRandomValues(new Uint8Array(16)), account={email,name,salt:bytesToBase64(salt),verifier:await passwordHash(password,salt)};
        list.push(account);localStorage.setItem(ACCOUNTS_KEY,JSON.stringify(list));
        migrateLegacyWorkspace(email);
        sessionStorage.setItem(SESSION_KEY,email);if($('#remember-session').checked)localStorage.setItem(SESSION_KEY,email);
        showWorkspace(account); return;
      }
      const account=list.find(a=>a.email===email);
      if(!account || await passwordHash(password,base64ToBytes(account.salt))!==account.verifier){error.textContent='Email or password is incorrect.';return;}
      sessionStorage.setItem(SESSION_KEY,email);if($('#remember-session').checked)localStorage.setItem(SESSION_KEY,email);else localStorage.removeItem(SESSION_KEY);
      showWorkspace(account);
    } catch(err) { error.textContent=err.message||'Could not sign in. Please try again.'; }
  });
  $('#assistant-form').addEventListener('submit',e=>{e.preventDefault();const input=$('#assistant-input'), question=input.value.trim();if(!question)return;appendAssistantMessage(question,'user');input.value='';window.setTimeout(()=>appendAssistantMessage(assistantAnswer(question),'assistant'),180);});
  $$('.assistant-prompts [data-assistant-prompt]').forEach(button=>button.addEventListener('click',()=>{$('#assistant-input').value=button.dataset.assistantPrompt;$('#assistant-form').requestSubmit();}));
  addPeriodOptions('payroll-month','payroll-year');addPeriodOptions('vat-month','vat-year');
  // The P9 card has a single year selector; build its options explicitly.
  $('#p9-year').innerHTML=Array.from({length:13},(_,i)=>2023+i).map(y=>`<option>${y}</option>`).join('');$('#p9-year').value=activeYear;
  $('#today-label').textContent=now.toLocaleDateString('en-KE',{weekday:'short',day:'2-digit',month:'short',year:'numeric'});
  initAuth();
})();
