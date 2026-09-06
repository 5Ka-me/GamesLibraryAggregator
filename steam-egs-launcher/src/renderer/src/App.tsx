import React, { useEffect } from 'react';
import { HashRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { ThemeProvider, I18nProvider, configurePlatform, type Game } from '@app/shared';
import { LegendaryProvider } from './legendary/LegendaryProvider';
import AppLayout from './components/AppLayout';
import LibraryPage from './pages/LibraryPage';
import StorePage from './pages/StorePage';
import SectionPage from './pages/SectionPage';
import GameDetailsPage from './pages/GameDetailsPage';
import StatsPage from './pages/StatsPage';
import RandomPage from './pages/RandomPage';
import SettingsPage from './pages/SettingsPage';

// Registers router-dependent platform hooks: library cards navigate to the
// in-app game page (shared GameCard switches to compact actions because of it).
const NavBridge: React.FC = () => {
  const navigate = useNavigate();
  useEffect(() => {
    configurePlatform({
      openGameDetails: (game: Game) => navigate('/game', { state: { game } }),
    });
    return () => configurePlatform({ openGameDetails: null });
  }, [navigate]);
  return null;
};

// HashRouter because the packaged app is loaded from file:// (no server to
// handle history paths). All pages render inside the persistent sidebar layout.
const App: React.FC = () => (
  <I18nProvider>
    <ThemeProvider>
      <LegendaryProvider>
        <HashRouter>
          <NavBridge />
          <Routes>
            <Route element={<AppLayout />}>
              <Route path="/" element={<LibraryPage />} />
              <Route path="/store" element={<StorePage />} />
              <Route path="/store/section/:id" element={<SectionPage />} />
              <Route path="/store/app/:appid" element={<GameDetailsPage />} />
              <Route path="/game" element={<GameDetailsPage />} />
              <Route path="/random" element={<RandomPage />} />
              <Route path="/stats" element={<StatsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>
          </Routes>
        </HashRouter>
      </LegendaryProvider>
    </ThemeProvider>
  </I18nProvider>
);

export default App;
