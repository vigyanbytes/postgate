// Secrets are referenced by environment variable NAME only (e.g. LINKEDIN_MEMBER_TOKEN). Whatever secret
// manager you use puts the values into the worker's environment; this module never logs or returns
// values to anything but the in-memory caller.

export const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;

export interface SecretResolver {
  get(name: string): string | undefined;
}

export function envSecretResolver(env: Record<string, string | undefined> = process.env): SecretResolver {
  return {
    get(name) {
      if (!SECRET_NAME.test(name)) throw new Error(`invalid secret name: ${name}`);
      const v = env[name];
      return v === undefined || v === '' ? undefined : v;
    },
  };
}
