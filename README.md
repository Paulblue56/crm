# CRM

CRM combines the three workbook workflows in one responsive website:

- **Payroll:** record a payroll row, import an iTax CSV, or paste rows copied from the workbook’s iTax Import Form or P9 Input Form. Review statutory deductions, PAYE and employer costs by company and month. Export the selected period to CSV.
- **P9 forms:** use the KRA-style P9A layout for each employee. Print one employee or create a combined, one-card-per-page company/year PDF.
- **VAT analysis:** record sales and purchases, import the workbook's CSV layout, choose a transaction direction and import-wide tax type (standard VAT, fuel, zero-rated, or exempt), calculate VAT using invoice dates, and export a period to CSV.
- **Companies and tax rules:** keep employer details in one list and inspect the effective-dated schedules used in calculations.
- **CRM Assistant:** a local rule-based preview that summarizes this browser's payroll, VAT, and P9 data.
- **Tax news:** a dashboard digest linking to KRA and Kenya Law notices relevant to payroll, VAT, and tax compliance.
- **Sign in / sign up:** Supabase email/password authentication and per-user cloud workspaces when configured; browser-only accounts remain available until configuration is added.

## Open the website

Open `index.html` in a modern browser. The app has no build step or package install. It is also a static site and can be hosted on a web server. It uses browser storage until Supabase is configured. For cloud accounts, create a Supabase project, run [`supabase/schema-setup.sql`](supabase/schema-setup.sql) in the SQL Editor, then set the Project URL and publishable/anon key in `supabase-config.js`. Never use a secret/service-role key in the website. Supabase Auth and Row Level Security isolate each account. Existing local records are only uploaded after the user explicitly confirms the migration prompt.

Start by adding a company. Then add payroll rows or import a CSV, and the P9 view will use those records. VAT invoices are recorded separately under the same company.

## Tax period handling

Calculation schedules are stored in `rules.js` with effective dates. PAYE bands follow the KRA schedule effective 1 July 2023. SHIF, AHL, and NSSF use their effective statutory periods. VAT uses invoice dates, including the historical 14% general rate in April–June 2020, the 8% petroleum period, the return to 16% from July 2023, and the 2026 temporary reduced rates for specified petroleum products. Exempt and zero-rated supplies are kept as separate types.

Imported iTax PAYE values are retained as imported values. Manually entered payroll rows use CRM's statutory calculation and show the calculated result. Review the breakdown and effective rule period before using a card or amount for filing. The rule schedules are reference configuration and should be updated when new legislation or official guidance takes effect.

## Accounts, assistant, and news limitations

With Supabase configured, sign-in and records sync through its Auth and Postgres services. Without configuration, accounts and workspaces remain local to the browser. The assistant is rule-based and does not call an AI service. The tax news list is a dated snapshot with links to official sources, not a continuously refreshed feed.

The requested automatic tax-update workflow needs a hosted service to monitor official KRA and Kenya Law sources, preserve the original publication and effective dates, and publish a versioned rule schedule used by both web and desktop builds. Headlines or draft notices should not silently alter calculations: a change must be confirmed as enacted, its scope and effective date checked, and the affected calculations reviewed before release. This build does not yet monitor sources or automatically apply future changes.

## Desktop app later

The website files are kept framework-free so the same screens and calculation module can later be packaged in a desktop shell such as Tauri or Electron. A desktop build should add a local database and data backup/export before storing business records long term.
