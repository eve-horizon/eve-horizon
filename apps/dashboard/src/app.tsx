import { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useSearchParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EveAuthProvider } from '@eve-horizon/auth-react';
import { EveLoginGate } from '@eve-horizon/auth-react';
import { Layout } from '@/components/layout';
import { ErrorBoundary } from '@/components/error-boundary';
import { HomePage } from '@/pages/home';
import { JobsPage } from '@/pages/jobs';

// Code-split the larger pages to reduce initial bundle size
const AppsPage = lazy(() =>
  import('@/pages/apps').then((m) => ({ default: m.AppsPage })),
);
const ProjectPage = lazy(() =>
  import('@/pages/project').then((m) => ({ default: m.ProjectPage })),
);
const CostsPage = lazy(() =>
  import('@/pages/costs').then((m) => ({ default: m.CostsPage })),
);
const SystemPage = lazy(() =>
  import('@/pages/system').then((m) => ({ default: m.SystemPage })),
);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function PageFallback() {
  return (
    <div className="flex items-center justify-center p-12" style={{ color: 'var(--text-muted)' }}>
      <div className="text-label">Loading...</div>
    </div>
  );
}

function lazyRoute(element: React.ReactNode) {
  return <Suspense fallback={<PageFallback />}>{element}</Suspense>;
}

/** Redirect that preserves the current query string (project/env context). */
function RedirectKeepSearch({ to, extra }: { to: string; extra?: Record<string, string> }) {
  const [searchParams] = useSearchParams();
  const params = new URLSearchParams(searchParams);
  for (const [key, value] of Object.entries(extra ?? {})) {
    params.set(key, value);
  }
  const search = params.toString();
  return <Navigate to={{ pathname: to, search: search ? `?${search}` : '' }} replace />;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <EveAuthProvider apiUrl="/api">
        <EveLoginGate loadingFallback={<LoadingScreen />}>
          <BrowserRouter>
            <ErrorBoundary>
              <Routes>
                <Route element={<Layout />}>
                  <Route index element={<HomePage />} />
                  <Route path="apps" element={lazyRoute(<AppsPage />)} />
                  <Route path="apps/project" element={lazyRoute(<ProjectPage />)} />
                  <Route path="jobs" element={<JobsPage />} />
                  <Route path="costs" element={lazyRoute(<CostsPage />)} />
                  <Route path="system" element={lazyRoute(<SystemPage />)} />

                  {/* Legacy routes — preserve context params */}
                  <Route path="board" element={<RedirectKeepSearch to="/jobs" extra={{ view: 'board' }} />} />
                  <Route path="project" element={<RedirectKeepSearch to="/apps/project" />} />
                  <Route path="environments" element={<RedirectKeepSearch to="/apps" />} />
                  <Route path="spending" element={<RedirectKeepSearch to="/costs" />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Route>
              </Routes>
            </ErrorBoundary>
          </BrowserRouter>
        </EveLoginGate>
      </EveAuthProvider>
    </QueryClientProvider>
  );
}

function LoadingScreen() {
  return (
    <div className="flex items-center justify-center h-screen" style={{ background: 'var(--bg-0)' }}>
      <div className="text-center">
        <div
          className="w-11 h-11 mx-auto mb-3 rounded-xl flex items-center justify-center font-display font-bold text-white text-lg"
          style={{ background: 'var(--horizon)' }}
        >
          E
        </div>
        <div className="text-label" style={{ color: 'var(--text-muted)' }}>Loading...</div>
      </div>
    </div>
  );
}
