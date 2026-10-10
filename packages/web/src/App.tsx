import { useEffect } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { setWeekStart } from "@mp/core/shared";
import { usePhotos, useSettings } from "./api";
import { Loading } from "./ui";
import { Book, Calendar, Cart, Camera, Database, Dots, Gear, Plus, Upload, Utensils } from "./icons";
import { FoodsPage } from "./pages/FoodsPage";
import { ImportPage } from "./pages/ImportPage";
import { MorePage } from "./pages/MorePage";
import { PhotoPage, PhotosPage } from "./pages/PhotosPages";
import { PlanPage } from "./pages/PlanPage";
import { RecipeEditPage } from "./pages/RecipeEditPage";
import { RecipePage } from "./pages/RecipePage";
import { RecipesPage } from "./pages/RecipesPage";
import { ReviewPage } from "./pages/ReviewPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ShoppingPage } from "./pages/ShoppingPage";

const tabs = [
  { to: "/", label: "Recipes", icon: <Book />, end: true, match: (p: string) => p === "/" || p.startsWith("/recipes") || p === "/new" },
  { to: "/plan", label: "Plan", icon: <Calendar />, match: (p: string) => p.startsWith("/plan") },
  { to: "/import", label: "Add", icon: <Plus />, match: (p: string) => p.startsWith("/import") || p.startsWith("/photos") },
  { to: "/shopping", label: "Shop", icon: <Cart />, match: (p: string) => p.startsWith("/shopping") },
  { to: "/more", label: "More", icon: <Dots />, match: (p: string) => p.startsWith("/more") || p.startsWith("/nutrition") || p.startsWith("/settings") },
];

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

export function App() {
  const { pathname } = useLocation();
  const { data: photos } = usePhotos();
  // which day the week starts on is a setting; every page that works out "this week" needs it first
  const { data: settings } = useSettings();
  if (settings) setWeekStart(settings.weekStartsOn);
  const waiting = photos?.photos.filter((p) => p.status === "waiting").length ?? 0;
  return (
    <div className="shell">
      <ScrollToTop />
      <aside className="sidebar">
        <div className="brand">
          <span style={{ fontSize: "1.6rem" }}>🍲</span> Meal Planner
        </div>
        {tabs
          .filter((t) => t.to !== "/more")
          .map((t) => (
            <NavLink key={t.to} to={t.to} className={`nav ${t.match(pathname) ? "active" : ""}`}>
              {t.to === "/import" ? <Upload /> : t.icon}
              {t.to === "/import" ? "Add recipe" : t.label === "Shop" ? "Shopping list" : t.label}
            </NavLink>
          ))}
        <NavLink to="/photos" className={`nav ${pathname.startsWith("/photos") ? "active" : ""}`}>
          <Camera /> Saved photos
          {waiting > 0 && <span className="badge amber" style={{ marginLeft: "auto" }}>{waiting}</span>}
        </NavLink>
        <NavLink to="/new" className="nav">
          <Utensils /> Write a recipe
        </NavLink>
        <NavLink to="/nutrition" className={`nav ${pathname.startsWith("/nutrition") ? "active" : ""}`}>
          <Database /> Nutrition data
        </NavLink>
        <NavLink to="/settings" className={`nav ${pathname.startsWith("/settings") ? "active" : ""}`}>
          <Gear /> Settings
        </NavLink>
      </aside>

      <main className="main">
        <div className="page">
          {!settings ? (
            <Loading />
          ) : (
          <Routes>
            <Route path="/" element={<RecipesPage />} />
            <Route path="/recipes/:slug" element={<RecipePage />} />
            <Route path="/recipes/:slug/edit" element={<RecipeEditPage />} />
            <Route path="/new" element={<RecipeEditPage />} />
            <Route path="/import" element={<ImportPage />} />
            <Route path="/import/review" element={<ReviewPage />} />
            <Route path="/photos" element={<PhotosPage />} />
            <Route path="/photos/:id" element={<PhotoPage />} />
            <Route path="/plan" element={<PlanPage />} />
            <Route path="/plan/:week" element={<PlanPage />} />
            <Route path="/shopping" element={<ShoppingPage />} />
            <Route path="/shopping/:week" element={<ShoppingPage />} />
            <Route path="/nutrition" element={<FoodsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/more" element={<MorePage />} />
            <Route path="*" element={<div className="empty"><div className="big">🤔</div><h3>Nothing here</h3><NavLink to="/">Back to recipes</NavLink></div>} />
          </Routes>
          )}
        </div>
      </main>

      <nav className="tabbar" aria-label="Main">
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} className={`tab ${t.match(pathname) ? "active" : ""}`}>
            {t.icon}
            {t.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
