import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@fontsource-variable/inter';
import '@fontsource-variable/plus-jakarta-sans';
import { App } from './app/App';
import './styles/tokens.css';
import './styles/global.css';

const root = document.getElementById('root');
if (!root) throw new Error('Application root is missing');

const queryClient = new QueryClient();

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
