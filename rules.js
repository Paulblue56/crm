/* Effective-dated reference schedules. Extend these records when Kenyan legislation changes.
   VAT: petroleum was 8% from 2018-09-21 until 2023-06-30; 2026 Legal Notices 69/70
   move the eligible petroleum rate through 13% on 2026-04-15 and 8% from 2026-04-16.
   The extension schedule is currently modeled through 2027-01-14 (LN 141/2026).
*/
window.CRM_RULES = {
  paye: [{ from: '2023-07-01', bands: [[24000, .10], [8333, .25], [467667, .30], [300000, .325], [Infinity, .35]], residentRelief: 2400 }],
  shif: [{ from: '2024-10-01', rate: .0275, minimum: 300 }],
  ahl: [{ from: '2024-07-01', employeeRate: .015, employerRate: .015 }],
  nssf: [
    { from: '2023-02-01', lower: 6000, upper: 18000 },
    { from: '2024-02-01', lower: 7000, upper: 36000 },
    { from: '2025-02-01', lower: 8000, upper: 72000 },
    { from: '2026-02-01', lower: 9000, upper: 108000 }
  ],
  vat: [
    { from: '2018-09-21', standard: .16, petroleum: .08 },
    { from: '2020-04-01', standard: .14, petroleum: .08 },
    { from: '2020-07-01', standard: .16, petroleum: .08 },
    { from: '2023-07-01', standard: .16, petroleum: .16 },
    { from: '2026-04-15', standard: .16, petroleum: .13 },
    { from: '2026-04-16', standard: .16, petroleum: .08 },
    { from: '2027-01-15', standard: .16, petroleum: .16 }
  ],
  reducedPetroleum: { from: '2026-04-16', through: '2027-01-14', qualifying: ['premium motor spirit', 'illuminating kerosene', 'automotive gas oil'] }
};
