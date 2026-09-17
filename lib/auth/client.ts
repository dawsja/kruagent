"use client";

import { usernameClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/** Browser auth client. It talks to /api/auth on whatever origin Kru is open on. */
export const authClient = createAuthClient({
  plugins: [usernameClient()],
});
