import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import { NotificationProvider } from './context/NotificationContext.jsx';
import useAuth from './hooks/useAuth.js';
import './index.css';

/** Inner wrapper so NotificationProvider can read the AuthContext user. */
function AppWithNotifications() {
  const { user } = useAuth();
  return (
    <NotificationProvider user={user}>
      <App />
    </NotificationProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <AppWithNotifications />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
