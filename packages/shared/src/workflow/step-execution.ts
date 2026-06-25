export type ScriptStepConfig = {
  command: string;
  timeoutSeconds: number | null;
  config: Record<string, unknown>;
};

export type StepExecution = {
  executionType: 'agent' | 'script' | 'action';
  scriptCommand: string | null;
  scriptTimeoutSeconds: number | null;
  actionType: string | null;
  actionInput: Record<string, unknown> | null;
  agentConfig: Record<string, unknown> | null;
};

export class StepExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StepExecutionError';
  }
}

export function getScriptConfig(step: Record<string, unknown>): ScriptStepConfig | null {
  if (step.script && typeof step.script === 'object' && !Array.isArray(step.script)) {
    const script = step.script as Record<string, unknown>;
    const runValue = typeof script.run === 'string' ? script.run : null;
    const commandValue = typeof script.command === 'string' ? script.command : null;
    const command = runValue ?? commandValue;
    if (command && command.trim().length > 0) {
      const timeout =
        typeof script.timeout === 'number'
          ? script.timeout
          : typeof script.timeout_seconds === 'number'
            ? script.timeout_seconds
            : null;
      return {
        command,
        timeoutSeconds: timeout,
        config: script,
      };
    }
  }

  if (typeof step.run === 'string' && step.run.trim().length > 0) {
    return {
      command: step.run,
      timeoutSeconds: null,
      config: { run: step.run },
    };
  }

  return null;
}

export function parseStepExecution(
  step: Record<string, unknown>,
  stepName: string,
): StepExecution {
  const action = step.action && typeof step.action === 'object' && !Array.isArray(step.action)
    ? step.action as Record<string, unknown>
    : null;
  if (action) {
    if (typeof action.type !== 'string' || action.type.trim().length === 0) {
      throw new StepExecutionError(`Step "${stepName}" action must define a non-empty type`);
    }
    const { type: _type, ...actionInput } = action;
    return {
      executionType: 'action',
      scriptCommand: null,
      scriptTimeoutSeconds: null,
      actionType: action.type,
      actionInput,
      agentConfig: null,
    };
  }

  const scriptConfig = getScriptConfig(step);
  if (scriptConfig) {
    return {
      executionType: 'script',
      scriptCommand: scriptConfig.command,
      scriptTimeoutSeconds: scriptConfig.timeoutSeconds,
      actionType: null,
      actionInput: null,
      agentConfig: null,
    };
  }

  const agent = step.agent && typeof step.agent === 'object' && !Array.isArray(step.agent)
    ? step.agent as Record<string, unknown>
    : null;
  if (agent) {
    return {
      executionType: 'agent',
      scriptCommand: null,
      scriptTimeoutSeconds: null,
      actionType: null,
      actionInput: null,
      agentConfig: agent,
    };
  }

  throw new StepExecutionError(
    `Step "${stepName}" has no recognized execution type (action, script, run, or agent)`,
  );
}

export const parseWorkflowStepExecution = parseStepExecution;
