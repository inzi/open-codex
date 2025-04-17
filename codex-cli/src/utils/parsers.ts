import type { CommandReviewDetails } from "./agent/review.js";
import type {
  ExecInput,
  ExecOutputMetadata,
} from "./agent/sandbox/interface.js";
import type { SafeCommandReason } from "@lib/approvals.js";
import type { ResponseFunctionToolCall } from "openai/resources/responses/responses.mjs";
import type { ChatCompletionMessageToolCall } from "openai/resources/chat/completions.mjs";
import { log } from "node:console";
import process from "process";

// The console utility import is intentionally explicit to avoid bundlers from
// including the entire `console` module when only the `log` function is
// required.

// Allowed shell operators that we consider "safe" as they do not introduce
// side‑effects on their own (unlike redirections). Parentheses and braces for
// grouping are excluded for simplicity.
const SAFE_SHELL_OPERATORS: ReadonlySet<string> = new Set([
  "&&",
  "||",
  "|",
  ";",
]);

// Lazily resolve heavy dependencies at runtime to avoid test environments
// (which might not have the @lib alias configured) from failing at import
// time. If the modules cannot be loaded we fall back to permissive stub
// implementations so that basic functionality – like unit‑testing small UI
// helpers – continues to work without the full codex‑lib dependency tree.

let isSafeCommand: (cmd: Array<string>) => SafeCommandReason | null = () =>
  null;
let shellQuoteParse:
  | ((cmd: string, env?: Record<string, string | undefined>) => Array<unknown>)
  | undefined;
let formatCommandForDisplay: (cmd: Array<string>) => string = (cmd) =>
  cmd.join(" ");

async function loadLibs(): Promise<void> {
  try {
    const approvals = await import("@lib/approvals.js");
    if (typeof approvals.isSafeCommand === "function") {
      isSafeCommand = approvals.isSafeCommand;
    }
  } catch {
    // ignore – keep stub
  }
  try {
    const fmt = await import("@lib/format-command.js");
    if (typeof fmt.formatCommandForDisplay === "function") {
      formatCommandForDisplay = fmt.formatCommandForDisplay;
    }
  } catch {
    // ignore – keep stub
  }
  try {
    const sq = await import("shell-quote");
    if (typeof sq.parse === "function") {
      shellQuoteParse = sq.parse as typeof shellQuoteParse;
    }
  } catch {
    // ignore – keep stub
  }
}

// Trigger the dynamic import in the background; callers that need the real
// implementation should await the returned promise (parsers currently does not
// require this for correctness during tests).
void loadLibs();

export function parseToolCallOutput(toolCallOutput: string): {
  output: string;
  metadata: ExecOutputMetadata;
} {
  try {
    const { output, metadata } = JSON.parse(toolCallOutput);
    return {
      output,
      metadata,
    };
  } catch (err) {
    return {
      output: `Failed to parse JSON result`,
      metadata: {
        exit_code: 1,
        duration_seconds: 0,
      },
    };
  }
}

export function parseToolCallChatCompletion(
  toolCall: ChatCompletionMessageToolCall,
): CommandReviewDetails | undefined {
  if (toolCall.type !== "function") {
    return undefined;
  }
  const toolCallArgs = parseToolCallArguments(toolCall.function.arguments);
  if (toolCallArgs == null) {
    return undefined;
  }
  const { cmd } = toolCallArgs;
  const cmdReadableText = formatCommandForDisplay(cmd);
  const autoApproval = computeAutoApproval(cmd);
  return {
    cmd,
    cmdReadableText,
    autoApproval,
  };
}

export function parseToolCall(
  toolCall: ResponseFunctionToolCall,
): CommandReviewDetails | undefined {
  const toolCallArgs = parseToolCallArguments(toolCall.arguments);
  if (toolCallArgs == null) {
    return undefined;
  }

  const { cmd } = toolCallArgs;
  const cmdReadableText = formatCommandForDisplay(cmd);

  const autoApproval = computeAutoApproval(cmd);

  return {
    cmd,
    cmdReadableText,
    autoApproval,
  };
}

/**
 * If toolCallArguments is a string of JSON that can be parsed into an object
 * with a "cmd" or "command" property that is an `Array<string>`, then returns
 * that array. Otherwise, returns undefined.
 */
export function parseToolCallArguments(
  toolCallArguments: string,
): ExecInput | undefined {
  let json: unknown;
  try {
    json = JSON.parse(toolCallArguments);
  } catch (err) {
    log(`Failed to parse toolCall.arguments: ${toolCallArguments}`);
    return undefined;
  }

  if (typeof json !== "object" || json == null) {
    return undefined;
  }

  const { cmd, command } = json as Record<string, unknown>;
  const commandArray = toStringArray(cmd) ?? toStringArray(command);
  if (commandArray == null) {
    return undefined;
  }

  // @ts-expect-error timeout and workdir may not exist on json.
  const { timeout, workdir } = json;
  return {
    cmd: commandArray,
    workdir: typeof workdir === "string" ? workdir : undefined,
    timeoutInMillis: typeof timeout === "number" ? timeout : undefined,
  };
}

function toStringArray(obj: unknown): Array<string> | undefined {
  if (Array.isArray(obj) && obj.every((item) => typeof item === "string")) {
    const arrayOfStrings: Array<string> = obj;
    return arrayOfStrings;
  } else {
    return undefined;
  }
}

// ---------------- safe‑command helpers ----------------

/**
 * Attempts to determine whether `cmd` is composed exclusively of safe
 * sub‑commands combined using only operators from the SAFE_SHELL_OPERATORS
 * allow‑list. Returns the `SafeCommandReason` (taken from the first sub‑command)
 * if the whole expression is safe; otherwise returns `null`.
 */
function computeAutoApproval(cmd: Array<string>): SafeCommandReason | null {
  // Fast path: a simple command with no shell processing.
  const direct = isSafeCommand(cmd);
  if (direct != null) {
    return direct;
  }

  // For expressions like ["bash", "-lc", "ls && pwd"] break down the inner
  // string and verify each segment.
  if (
    cmd.length === 3 &&
    cmd[0] === "bash" &&
    cmd[1] === "-lc" &&
    typeof cmd[2] === "string" &&
    shellQuoteParse
  ) {
    const parsed = shellQuoteParse(cmd[2], process.env ?? {});
    if (parsed.length === 0) {
      return null;
    }

    let current: Array<string> = [];
    let first: SafeCommandReason | null = null;

    const flush = (): boolean => {
      if (current.length === 0) {
        return true;
      }
      const safe = isSafeCommand(current);
      if (safe == null) {
        return false;
      }
      if (!first) {
        first = safe;
      }
      current = [];
      return true;
    };

    for (const part of parsed) {
      if (typeof part === "string") {
        // Simple word/argument token.
        if (part === "(" || part === ")" || part === "{" || part === "}") {
          // We treat explicit grouping tokens as unsafe because their
          // semantics depend on the shell evaluation environment.
          return null;
        }
        current.push(part);
      } else if (part && typeof part === "object") {
        const opToken = part as { op?: string };
        if (typeof opToken.op === "string") {
          if (!flush()) {
            return null;
          }
          if (!SAFE_SHELL_OPERATORS.has(opToken.op)) {
            return null;
          }
        } else {
          // Unknown object token kind (e.g. redirection) – treat as unsafe.
          return null;
        }
      } else {
        // Token types such as numbers / booleans are unexpected – treat as unsafe.
        return null;
      }
    }

    if (!flush()) {
      return null;
    }

    return first;
  }

  return null;
}
