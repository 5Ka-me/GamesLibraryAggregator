import React from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';

// Fixed, non-collapsible left sidebar + scrollable content area.
const AppLayout: React.FC = () => (
  <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
    <Sidebar />
    {/* id is used by pages to save/restore their scroll position */}
    <main id="app-scroll" style={{ flex: 1, minWidth: 0, height: '100%', overflowY: 'auto' }}>
      <Outlet />
    </main>
  </div>
);

export default AppLayout;
