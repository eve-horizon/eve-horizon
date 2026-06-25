import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export type LocalMeshProject = {
  name: string;
  path: string;
  role?: string;
};

export type LocalMeshDefaults = {
  direct: boolean;
  pre_check: boolean;
  cli_image_registry: string;
};

export type LocalMeshWorkspace = {
  name: string;
  org?: string;
  env: string;
  profile?: string;
  projects: LocalMeshProject[];
  defaults: LocalMeshDefaults;
};

export type ResolvedLocalMeshProject = LocalMeshProject & {
  resolvedPath: string;
};

export type ResolvedLocalMeshWorkspace = LocalMeshWorkspace & {
  path: string;
  projects: ResolvedLocalMeshProject[];
};

export type WorkspaceSummary = {
  name: string;
  path: string;
  active: boolean;
};

const ACTIVE_WORKSPACE_FILE = 'active-workspace';
const WORKSPACES_DIR = 'workspaces';

export function getEveHome(): string {
  const override = process.env.EVE_HOME?.trim();
  return override ? resolveExpandedPath(override) : join(homedir(), '.eve');
}

export function getWorkspacesDir(): string {
  return join(getEveHome(), WORKSPACES_DIR);
}

export function getActiveWorkspaceName(): string | null {
  const activePath = join(getEveHome(), ACTIVE_WORKSPACE_FILE);
  if (!existsSync(activePath)) return null;
  const value = readFileSync(activePath, 'utf-8').trim();
  return value || null;
}

export function setActiveWorkspaceName(name: string): void {
  const activePath = join(getEveHome(), ACTIVE_WORKSPACE_FILE);
  mkdirSync(dirname(activePath), { recursive: true });
  writeFileSync(activePath, `${name}\n`);
}

export function workspacePathForName(name: string): string {
  return join(getWorkspacesDir(), `${name}.yaml`);
}

export function resolveWorkspaceSelector(selector?: string): string {
  const raw = selector?.trim();
  if (!raw) {
    const active = getActiveWorkspaceName();
    if (!active) {
      throw new Error('No active local mesh workspace. Run: eve local mesh use <name> or pass --workspace <name|path>.');
    }
    return workspacePathForName(active);
  }

  const expanded = expandPath(raw);
  if (raw.endsWith('.yaml') || raw.endsWith('.yml') || raw.includes('/') || raw.startsWith('~') || isAbsolute(expanded)) {
    return resolve(expanded);
  }
  return workspacePathForName(raw);
}

export function loadWorkspace(selector?: string): ResolvedLocalMeshWorkspace {
  const path = resolveWorkspaceSelector(selector);
  if (!existsSync(path)) {
    throw new Error(`Local mesh workspace not found: ${path}`);
  }

  const parsed = parseYaml(readFileSync(path, 'utf-8')) as Record<string, unknown> | null;
  const workspace = normalizeWorkspace(parsed, path);
  return {
    ...workspace,
    path,
    projects: workspace.projects.map((project) => ({
      ...project,
      resolvedPath: resolveExpandedPath(project.path),
    })),
  };
}

export function createWorkspace(input: {
  name: string;
  org?: string;
  env?: string;
  profile?: string;
  force?: boolean;
}): ResolvedLocalMeshWorkspace {
  const name = normalizeWorkspaceName(input.name);
  const path = workspacePathForName(name);
  if (existsSync(path) && !input.force) {
    throw new Error(`Workspace already exists: ${path}`);
  }

  const workspace: LocalMeshWorkspace = {
    name,
    ...(input.org ? { org: input.org } : {}),
    env: input.env ?? 'local',
    ...(input.profile ? { profile: input.profile } : {}),
    projects: [],
    defaults: {
      direct: true,
      pre_check: true,
      cli_image_registry: 'local',
    },
  };
  writeWorkspace(path, workspace);
  setActiveWorkspaceName(name);
  return loadWorkspace(path);
}

export function addProjectToWorkspace(
  selector: string | undefined,
  project: LocalMeshProject,
): ResolvedLocalMeshWorkspace {
  const path = resolveWorkspaceSelector(selector);
  const workspace = existsSync(path)
    ? loadWorkspace(path)
    : (() => {
        throw new Error(`Local mesh workspace not found: ${path}`);
      })();

  if (!project.name.trim()) {
    throw new Error('Project name is required.');
  }
  if (!project.path.trim()) {
    throw new Error('Project path is required.');
  }

  const nextProjects = workspace.projects
    .filter((entry) => entry.name !== project.name)
    .map((entry) => ({
      name: entry.name,
      path: entry.path,
      ...(entry.role ? { role: entry.role } : {}),
    }));
  nextProjects.push({
    ...project,
    path: resolveExpandedPath(project.path),
  });

  writeWorkspace(path, {
    ...workspace,
    projects: nextProjects,
  });
  return loadWorkspace(path);
}

export function listWorkspaces(): WorkspaceSummary[] {
  const dir = getWorkspacesDir();
  const active = getActiveWorkspaceName();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.yaml') || entry.endsWith('.yml'))
    .sort()
    .map((entry) => {
      const name = entry.replace(/\.ya?ml$/, '');
      return {
        name,
        path: join(dir, entry),
        active: active === name,
      };
    });
}

export function writeWorkspace(path: string, workspace: LocalMeshWorkspace): void {
  const payload: LocalMeshWorkspace = {
    name: normalizeWorkspaceName(workspace.name),
    ...(workspace.org ? { org: workspace.org } : {}),
    env: workspace.env || 'local',
    ...(workspace.profile ? { profile: workspace.profile } : {}),
    projects: workspace.projects.map((project) => ({
      name: project.name,
      path: project.path,
      ...(project.role ? { role: project.role } : {}),
    })),
    defaults: {
      direct: workspace.defaults?.direct ?? true,
      pre_check: workspace.defaults?.pre_check ?? true,
      cli_image_registry: workspace.defaults?.cli_image_registry ?? 'local',
    },
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyYaml(payload));
}

export function resolveExpandedPath(value: string): string {
  return resolve(expandPath(value));
}

function normalizeWorkspace(parsed: Record<string, unknown> | null, path: string): LocalMeshWorkspace {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid workspace YAML: ${path}`);
  }

  const name = typeof parsed.name === 'string' ? normalizeWorkspaceName(parsed.name) : '';
  if (!name) {
    throw new Error(`Workspace ${path} is missing name.`);
  }

  const projectsRaw = Array.isArray(parsed.projects) ? parsed.projects : [];
  const projects: LocalMeshProject[] = projectsRaw.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Workspace ${name} project at index ${index} must be an object.`);
    }
    const project = entry as Record<string, unknown>;
    const projectName = typeof project.name === 'string' ? project.name.trim() : '';
    const projectPath = typeof project.path === 'string' ? project.path.trim() : '';
    if (!projectName || !projectPath) {
      throw new Error(`Workspace ${name} project at index ${index} must include name and path.`);
    }
    return {
      name: projectName,
      path: projectPath,
      ...(typeof project.role === 'string' && project.role ? { role: project.role } : {}),
    };
  });

  const defaultsRaw = (parsed.defaults && typeof parsed.defaults === 'object')
    ? parsed.defaults as Record<string, unknown>
    : {};

  return {
    name,
    ...(typeof parsed.org === 'string' && parsed.org.trim() ? { org: parsed.org.trim() } : {}),
    env: typeof parsed.env === 'string' && parsed.env.trim() ? parsed.env.trim() : 'local',
    ...(typeof parsed.profile === 'string' && parsed.profile.trim() ? { profile: parsed.profile.trim() } : {}),
    projects,
    defaults: {
      direct: typeof defaultsRaw.direct === 'boolean' ? defaultsRaw.direct : true,
      pre_check: typeof defaultsRaw.pre_check === 'boolean' ? defaultsRaw.pre_check : true,
      cli_image_registry: typeof defaultsRaw.cli_image_registry === 'string' && defaultsRaw.cli_image_registry.trim()
        ? defaultsRaw.cli_image_registry.trim()
        : 'local',
    },
  };
}

function normalizeWorkspaceName(name: string): string {
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)) {
    throw new Error('Workspace name must start with a letter or number and contain only letters, numbers, ".", "_", or "-".');
  }
  return trimmed;
}

function expandPath(value: string): string {
  let result = value;
  if (result === '~' || result.startsWith('~/')) {
    result = join(homedir(), result.slice(2));
  }
  result = result.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced: string, bare: string) => {
    const key = braced || bare;
    return process.env[key] ?? '';
  });
  return result;
}
