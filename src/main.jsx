import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import ComposeWindow from './ComposeWindow.jsx';
import './styles.css';
const m = /^#compose\/(\d+)/.exec(location.hash);
createRoot(document.getElementById('root')).render(m ? <ComposeWindow id={Number(m[1])} /> : <App />);
