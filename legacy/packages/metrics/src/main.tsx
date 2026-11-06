import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import MetricsApp from './MetricsApp';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MetricsApp />
  </StrictMode>,
);
