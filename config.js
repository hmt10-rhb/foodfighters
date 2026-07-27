'use strict';

// Supabase project — the anon key is meant to be public (it's the client-side
// key, safe to ship; real protection is the Row Level Security policies in
// supabase/schema.sql, not secrecy of this key).
//
// MIGRATED (2026-07-27): switched from the old project (ref
// nicljxqwnevtrfylsamp) to a fresh one (ref eukhuskplbjalkxrkcgi) after
// root-causing a data-reverting incident to something stuck on the OLD
// project's own infrastructure — proven via an isolated SQL-only test that
// reproduced on the old project and did NOT reproduce here. Old project's
// URL/key kept below, commented out, in case anything ever needs to
// reference it again (e.g. recovering old player data).
// window.SUPABASE_URL = 'https://nicljxqwnevtrfylsamp.supabase.co';
// window.SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5pY2xqeHF3bmV2dHJmeWxzYW1wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ2ODYyODQsImV4cCI6MjEwMDI2MjI4NH0._i8fFSQR5ymH3VPt_ABh-obn6ClGgQ06PZloLIfsVcM';
window.SUPABASE_URL = 'https://eukhuskplbjalkxrkcgi.supabase.co';
window.SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV1a2h1c2twbGJqYWxreHJrY2dpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUxMTc4ODUsImV4cCI6MjEwMDY5Mzg4NX0.SqZzE5zlTEVRmeXpwSMws0Pn4zNZBlzJqGNwbU9wIAs';
