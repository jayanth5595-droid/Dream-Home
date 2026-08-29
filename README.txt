DREAM HOME v3

Public read + owner-only edit + cloud sync.

1. Create a Supabase project.
2. Run supabase_schema.sql in Supabase SQL Editor.
3. Put the Supabase Project URL and publishable/anon key into config.js.
4. Upload all files to GitHub Pages.
5. Open the site. Anyone with the link can view the data.
6. Owner signs in and creates/edits the loan.
7. Never use the service_role/secret key in config.js.

The database has public SELECT policies and owner-only write policies.
The public-read design intentionally exposes the loan data to anyone with the URL.
