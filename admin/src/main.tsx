import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createApi } from './api';
import './style.css';

const root = document.getElementById('root');
if (root === null) throw new Error('#root ausente no index.html');

createRoot(root).render(
  <StrictMode>
    <App api={createApi()} />
  </StrictMode>,
);
