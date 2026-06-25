import { useState, useEffect, useRef, useCallback, useImperativeHandle, forwardRef } from 'react';
import { NavLink, Outlet, useSearchParams, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Boxes,
  ListChecks,
  CircleDollarSign,
  Activity,
  Sun,
  Moon,
  ChevronDown,
  LogOut,
} from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useProjects, type Project } from '@/hooks/use-projects';
import { useProjectEnvs } from '@/hooks/use-environments';
import { useJobStats } from '@/hooks/use-jobs';
import { getStoredTheme, applyTheme, type Theme } from '@/lib/theme';

// ---------------------------------------------------------------------------
// Exported context type — child routes consume this via useOutletContext
// ---------------------------------------------------------------------------
export interface LayoutContext {
  selectedProject: Project | null;
  activeOrg: { id: string; role: string; name?: string; slug?: string } | null;
  isAdmin: boolean;
  isOrgAdmin: boolean;
  selectedEnv: string | null;
  adminScope: boolean;
}

// ---------------------------------------------------------------------------
// Nav definition — five destinations, mobile-tab friendly
// ---------------------------------------------------------------------------
interface NavItem {
  to: string;
  icon: typeof LayoutDashboard;
  label: string;
  adminOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', icon: LayoutDashboard, label: 'Home' },
  { to: '/apps', icon: Boxes, label: 'Apps' },
  { to: '/jobs', icon: ListChecks, label: 'Jobs' },
  { to: '/costs', icon: CircleDollarSign, label: 'Costs' },
  { to: '/system', icon: Activity, label: 'System', adminOnly: true },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function userInitials(email?: string): string {
  if (!email) return '?';
  const parts = email.split('@')[0]!.split(/[._-]/);
  if (parts.length >= 2) {
    return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  }
  return email.slice(0, 2).toUpperCase();
}

function contextInitial(project: Project | null, org: { name?: string; slug?: string } | null): string {
  const source = project?.name ?? project?.slug ?? org?.name ?? org?.slug ?? 'E';
  return source[0]!.toUpperCase();
}

function useClickOutside(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [ref, onClose]);
}

function isNavActive(to: string, pathname: string): boolean {
  return to === '/' ? pathname === '/' : pathname.startsWith(to);
}

// ---------------------------------------------------------------------------
// Sidebar (desktop + tablet rail)
// ---------------------------------------------------------------------------
function Sidebar({
  navItems,
  pathname,
  persistentSearch,
}: {
  navItems: NavItem[];
  pathname: string;
  persistentSearch: string;
}) {
  return (
    <nav className="sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-logo">E</div>
        <div className="sidebar-wordmark">
          eve <span>horizon</span>
        </div>
      </div>

      {navItems.map((item) => {
        const Icon = item.icon;
        return (
          <NavLink
            key={item.to}
            to={{ pathname: item.to, search: persistentSearch }}
            end={item.to === '/'}
            className={`sidebar-item focus-ring ${isNavActive(item.to, pathname) ? 'active' : ''}`}
          >
            <Icon size={18} strokeWidth={1.8} />
            <span className="sidebar-item-label">{item.label}</span>
          </NavLink>
        );
      })}

      <div className="sidebar-footer">read-only console</div>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Mobile bottom tab bar
// ---------------------------------------------------------------------------
function TabBar({
  navItems,
  pathname,
  persistentSearch,
}: {
  navItems: NavItem[];
  pathname: string;
  persistentSearch: string;
}) {
  return (
    <nav className="tabbar">
      {navItems.map((item) => {
        const Icon = item.icon;
        return (
          <NavLink
            key={item.to}
            to={{ pathname: item.to, search: persistentSearch }}
            end={item.to === '/'}
            className={`tabbar-item ${isNavActive(item.to, pathname) ? 'active' : ''}`}
          >
            <Icon size={20} strokeWidth={1.8} />
            {item.label}
          </NavLink>
        );
      })}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Topbar
// ---------------------------------------------------------------------------
const Topbar = forwardRef<
  ProjectSelectorHandle,
  {
    projects: Project[];
    selectedProject: Project | null;
    onSelectProject: (id: string | null) => void;
    allowAllProjects: boolean;
    orgs: Array<{ id: string; role: string; name?: string; slug?: string }>;
    activeOrg: { id: string; role: string; name?: string; slug?: string } | null;
    onSwitchOrg: (orgId: string) => void;
    selectedEnv: string | null;
    onSelectEnv: (env: string | null) => void;
    envOptions: string[];
    isAdmin: boolean;
    isOrgAdmin: boolean;
    adminScope: boolean;
    onToggleAdminScope: () => void;
    theme: Theme;
    onToggleTheme: () => void;
    user: { email: string } | null;
    onLogout: () => void;
    jobStats: { active: number; review: number; failed: number } | null;
  }
>(function Topbar(
  {
    projects,
    selectedProject,
    onSelectProject,
    allowAllProjects,
    orgs,
    activeOrg,
    onSwitchOrg,
    selectedEnv,
    onSelectEnv,
    envOptions,
    isAdmin,
    isOrgAdmin,
    adminScope,
    onToggleAdminScope,
    theme,
    onToggleTheme,
    user,
    onLogout,
    jobStats,
  },
  fwdRef,
) {
  return (
    <header className="topbar">
      <div className="topbar-mobile-brand">E</div>

      <ProjectSelector
        ref={fwdRef}
        projects={projects}
        selectedProject={selectedProject}
        onSelectProject={onSelectProject}
        allowAllProjects={allowAllProjects}
        orgs={orgs}
        activeOrg={activeOrg}
        onSwitchOrg={onSwitchOrg}
      />

      <div className="topbar-sep" />

      <EnvSelector selectedEnv={selectedEnv} onSelectEnv={onSelectEnv} options={envOptions} />

      <div className="topbar-stats">
        {jobStats && (
          <>
            <div className="topbar-stat">
              <span className="topbar-stat-num">{jobStats.active}</span> active
            </div>
            <div className="topbar-stat">
              <span className="topbar-stat-num">{jobStats.review}</span> review
            </div>
            {jobStats.failed > 0 && (
              <div className="topbar-stat">
                <span className="topbar-stat-num" style={{ color: 'var(--red)' }}>
                  {jobStats.failed}
                </span>{' '}
                failed
              </div>
            )}
          </>
        )}
      </div>

      <div className="topbar-right">
        <button
          className="topbar-btn focus-ring"
          onClick={onToggleTheme}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </button>

        {(isAdmin || isOrgAdmin) && (
          <button
            className={`admin-toggle focus-ring ${adminScope ? 'active' : ''}`}
            onClick={onToggleAdminScope}
            title="Toggle admin scope"
          >
            Admin
          </button>
        )}

        <UserMenu user={user} onLogout={onLogout} />
      </div>
    </header>
  );
});

// ---------------------------------------------------------------------------
// Project / Org context selector
// ---------------------------------------------------------------------------
interface ProjectSelectorHandle {
  toggle: () => void;
  close: () => void;
}

const ProjectSelector = forwardRef<
  ProjectSelectorHandle,
  {
    projects: Project[];
    selectedProject: Project | null;
    onSelectProject: (id: string | null) => void;
    allowAllProjects: boolean;
    orgs: Array<{ id: string; role: string; name?: string; slug?: string }>;
    activeOrg: { id: string; role: string; name?: string; slug?: string } | null;
    onSwitchOrg: (orgId: string) => void;
  }
>(function ProjectSelector(
  { projects, selectedProject, onSelectProject, allowAllProjects, orgs, activeOrg, onSwitchOrg },
  fwdRef,
) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, useCallback(() => setOpen(false), []));

  useImperativeHandle(fwdRef, () => ({
    toggle: () => setOpen((v) => !v),
    close: () => setOpen(false),
  }));

  return (
    <div ref={ref} className="context-pill" onClick={() => setOpen(!open)}>
      <div className="context-pill-icon">{contextInitial(selectedProject, activeOrg)}</div>
      <span className="truncate max-w-[180px]">
        {selectedProject?.name ?? (allowAllProjects ? 'All projects' : 'Select project')}
      </span>
      <ChevronDown size={12} className="text-[var(--text-muted)] flex-shrink-0" />

      {open && (
        <div className="dropdown-menu" style={{ minWidth: 240 }} onClick={(e) => e.stopPropagation()}>
          {orgs.length > 1 && (
            <>
              <div className="dropdown-label">Organization</div>
              {orgs.map((org) => (
                <button
                  key={org.id}
                  className={`dropdown-item ${org.id === activeOrg?.id ? 'selected' : ''}`}
                  onClick={() => {
                    onSwitchOrg(org.id);
                    onSelectProject(null);
                    setOpen(false);
                  }}
                >
                  {org.name ?? org.slug ?? org.id.slice(0, 12)}
                </button>
              ))}
              <div style={{ height: 1, background: 'var(--border)', margin: '5px 0' }} />
            </>
          )}

          <div className="dropdown-label">Project</div>
          {allowAllProjects && (
            <button
              className={`dropdown-item ${!selectedProject ? 'selected' : ''}`}
              onClick={() => { onSelectProject(null); setOpen(false); }}
            >
              All projects
            </button>
          )}
          {projects.map((p) => (
            <button
              key={p.id}
              className={`dropdown-item ${p.id === selectedProject?.id ? 'selected' : ''}`}
              onClick={() => { onSelectProject(p.id); setOpen(false); }}
            >
              {p.name}
            </button>
          ))}
          {projects.length === 0 && (
            <div className="dropdown-item" style={{ color: 'var(--text-muted)', cursor: 'default' }}>
              No projects
            </div>
          )}
        </div>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Environment selector
// ---------------------------------------------------------------------------
function EnvSelector({
  selectedEnv,
  onSelectEnv,
  options,
}: {
  selectedEnv: string | null;
  onSelectEnv: (env: string | null) => void;
  options: string[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, useCallback(() => setOpen(false), []));

  return (
    <div ref={ref} className="env-selector" onClick={() => setOpen(!open)}>
      <span className="env-dot" />
      <span>{selectedEnv ?? 'all envs'}</span>
      <ChevronDown size={10} className="text-[var(--text-muted)] flex-shrink-0" />

      {open && (
        <div className="dropdown-menu" style={{ minWidth: 170 }} onClick={(e) => e.stopPropagation()}>
          <button
            className={`dropdown-item ${!selectedEnv ? 'selected' : ''}`}
            onClick={() => { onSelectEnv(null); setOpen(false); }}
          >
            All environments
          </button>
          {options.map((env) => (
            <button
              key={env}
              className={`dropdown-item ${env === selectedEnv ? 'selected' : ''}`}
              onClick={() => { onSelectEnv(env); setOpen(false); }}
            >
              {env}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// User avatar / menu
// ---------------------------------------------------------------------------
function UserMenu({
  user,
  onLogout,
}: {
  user: { email: string } | null;
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, useCallback(() => setOpen(false), []));

  return (
    <div ref={ref} className="relative">
      <div className="topbar-avatar" onClick={() => setOpen(!open)} title={user?.email}>
        {userInitials(user?.email)}
      </div>

      {open && (
        <div
          className="dropdown-menu"
          style={{ right: 0, left: 'auto', minWidth: 190 }}
          onClick={(e) => e.stopPropagation()}
        >
          {user?.email && (
            <div className="px-2.5 py-2 text-label text-[var(--text-muted)] truncate border-b border-[var(--border)]">
              {user.email}
            </div>
          )}
          <button className="dropdown-item" onClick={() => { onLogout(); setOpen(false); }}>
            <LogOut size={14} />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main layout
// ---------------------------------------------------------------------------
export function Layout() {
  const { user, orgs, activeOrg, switchOrg, logout } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const projectSelectorRef = useRef<ProjectSelectorHandle>(null);

  // Theme
  const [theme, setTheme] = useState<Theme>(getStoredTheme);
  useEffect(() => { applyTheme(theme); }, [theme]);
  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        projectSelectorRef.current?.toggle();
        return;
      }
      if (e.key === 'Escape') {
        projectSelectorRef.current?.close();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Admin scope toggle (persisted in sessionStorage)
  const [adminScope, setAdminScope] = useState(() => {
    try { return sessionStorage.getItem('eve_admin_scope') === '1'; } catch { return false; }
  });
  const toggleAdminScope = () => {
    setAdminScope((v) => {
      const next = !v;
      try { sessionStorage.setItem('eve_admin_scope', next ? '1' : '0'); } catch { /* */ }
      return next;
    });
  };

  // Projects
  const { data: projectsData } = useProjects(activeOrg?.id ?? null);
  const projects = projectsData?.items ?? [];

  // Selected project — synced to/from URL search param
  const projectIdFromUrl = searchParams.get('project');
  const selectedProject = projectIdFromUrl
    ? (projects.find((p) => p.id === projectIdFromUrl) ?? null)
    : null;

  const setSelectedProjectId = useCallback(
    (id: string | null) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (id) {
          next.set('project', id);
        } else {
          next.delete('project');
        }
        return next;
      }, { replace: true });
    },
    [setSearchParams],
  );

  // Selected environment — synced to URL
  const selectedEnv = searchParams.get('env') || null;
  const setSelectedEnv = useCallback(
    (env: string | null) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (env) {
          next.set('env', env);
        } else {
          next.delete('env');
        }
        return next;
      }, { replace: true });
    },
    [setSearchParams],
  );

  // Auth derived state
  const isAdmin = user?.isAdmin === true;
  const isOrgAdmin = activeOrg?.role === 'admin' || activeOrg?.role === 'owner';

  const { data: projectEnvsData } = useProjectEnvs(selectedProject?.id ?? null);
  const envOptions = selectedProject
    ? [...new Set((projectEnvsData?.data ?? []).map((env) => env.name))].sort()
    : [];

  // Job stats for the topbar
  const { data: jobStatsData } = useJobStats(activeOrg?.id ?? null);
  const jobStats = jobStatsData
    ? {
        active: jobStatsData.by_phase['active'] ?? 0,
        review: jobStatsData.by_phase['review'] ?? 0,
        failed: jobStatsData.by_phase['failed'] ?? jobStatsData.by_phase['cancelled'] ?? 0,
      }
    : null;

  // Nav filtered by role
  const navItems = NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin || isOrgAdmin);
  const persistentNavParams = new URLSearchParams();
  if (projectIdFromUrl) {
    persistentNavParams.set('project', projectIdFromUrl);
  }
  if (selectedEnv) {
    persistentNavParams.set('env', selectedEnv);
  }
  const persistentNavSearch = persistentNavParams.toString()
    ? `?${persistentNavParams.toString()}`
    : '';

  return (
    <div className="shell">
      <Sidebar
        navItems={navItems}
        pathname={location.pathname}
        persistentSearch={persistentNavSearch}
      />

      <Topbar
        ref={projectSelectorRef}
        projects={projects}
        selectedProject={selectedProject}
        onSelectProject={setSelectedProjectId}
        allowAllProjects
        orgs={orgs}
        activeOrg={activeOrg}
        onSwitchOrg={switchOrg}
        selectedEnv={selectedEnv}
        onSelectEnv={setSelectedEnv}
        envOptions={envOptions}
        isAdmin={isAdmin}
        isOrgAdmin={isOrgAdmin}
        adminScope={adminScope}
        onToggleAdminScope={toggleAdminScope}
        theme={theme}
        onToggleTheme={toggleTheme}
        user={user ? { email: user.email } : null}
        onLogout={logout}
        jobStats={jobStats}
      />

      <main className="content-area">
        <Outlet
          context={{
            selectedProject,
            activeOrg,
            isAdmin,
            isOrgAdmin,
            selectedEnv,
            adminScope,
          } satisfies LayoutContext}
        />
      </main>

      <TabBar
        navItems={navItems}
        pathname={location.pathname}
        persistentSearch={persistentNavSearch}
      />
    </div>
  );
}
