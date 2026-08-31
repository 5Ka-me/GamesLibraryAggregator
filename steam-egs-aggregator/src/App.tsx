import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider, I18nProvider } from '@app/shared';
import LibraryPage from './pages/LibraryPage';
import SettingsPage from './pages/SettingsPage';

const App: React.FC = () => {
  return (
    <I18nProvider>
      <ThemeProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<LibraryPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            {/* Unknown paths (e.g. a stale bookmark) land on the library
                instead of rendering a blank page. */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </ThemeProvider>
    </I18nProvider>
  );
};

export default App;
