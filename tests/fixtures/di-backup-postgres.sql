-- Synthetic data only. Executed exclusively in a disposable Docker container.
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY, encrypted_password text);
INSERT INTO auth.users VALUES ('11111111-1111-1111-1111-111111111111','SYNTHETIC_AUTH_MUST_NOT_EXPORT');
CREATE SCHEMA storage;
CREATE TABLE storage.buckets(id text, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
CREATE TABLE storage.objects(id uuid, bucket_id text, name text, updated_at timestamptz, metadata jsonb, owner_id text);
CREATE TABLE public.profiles(id uuid PRIMARY KEY REFERENCES auth.users(id), amount numeric(30,4), data jsonb, access_token text);
INSERT INTO public.profiles VALUES ('11111111-1111-1111-1111-111111111111',9007199254740993.1234,'{"userId":"11111111-1111-1111-1111-111111111111","amount":9007199254740993.1234,"credentials":{"password":"SYNTHETIC_NESTED_MUST_NOT_EXPORT"}}','SYNTHETIC_COLUMN_MUST_NOT_EXPORT');
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_profiles ON public.profiles FOR SELECT USING (true);
CREATE FUNCTION public.keep_profile() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;
CREATE TRIGGER keep_profile BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.keep_profile();
