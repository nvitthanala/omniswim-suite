export type AuthUser = {
  id: string;
  email: string;
  displayName: string;
  teamId?: string;
};

export async function fetchAuthMe(): Promise<{ user: AuthUser | null; authRequired: boolean }> {
  const res = await fetch('/api/auth/me', { credentials: 'include' });
  return res.json();
}

export async function login(email: string, password: string): Promise<AuthUser> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Login failed');
  }
  const data = await res.json();
  return data.user;
}

export async function register(
  email: string,
  password: string,
  displayName?: string
): Promise<AuthUser> {
  const res = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email, password, displayName }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Registration failed');
  }
  const data = await res.json();
  return data.user;
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
}

export async function inviteCoach(email: string): Promise<void> {
  const res = await fetch('/api/auth/invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Invite failed');
  }
}

export async function createShareLink(workspaceId: string, label?: string): Promise<{ url: string; token: string }> {
  const res = await fetch(`/api/workspaces/${workspaceId}/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ label }),
  });
  if (!res.ok) throw new Error('Failed to create share link');
  return res.json();
}
