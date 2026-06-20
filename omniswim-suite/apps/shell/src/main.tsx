import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider, SwimCloudProvider } from '@omniswim/ui';
import '@omniswim/ui/styles.css';
import App from './App';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <SwimCloudProvider>
          <App />
        </SwimCloudProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>
);
