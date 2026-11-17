// Host-only helpers for the Relate Graph space. Action code stays portable
// and reaches these through ctx.executePrivileged with the descriptors
// generated from the contracts below.

import { existsSync } from "node:fs";
import {
definePrivilegedContracts,
definePrivilegedHandlers,
z,
} from "@hatch/space-sdk";

export const privileged = definePrivilegedContracts({
  fileExists: {
    request: z.object({ path: z.string() }),
    response: z.object({ exists: z.boolean() }),
    timeoutMs: 5000,
  },
});

export const privilegedHandlers = definePrivilegedHandlers(privileged, {
  fileExists(args) {
    return { exists: existsSync(args.path) };
  },
});
