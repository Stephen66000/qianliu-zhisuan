/**
 * W18 路由 —— 七入口（TRD §11.1）+ 登录页 + 认证闸门。
 * / 重定向到 /dashboard。
 */
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { RequireAuth } from "./components/RequireAuth";
import { AlertsPage } from "./pages/Alerts";
import { DashboardPage } from "./pages/Dashboard";
import { LoginPage } from "./pages/Login";
import { PrincipalsPage } from "./pages/Principals";
import { QuotaRulesPage } from "./pages/QuotaRules";
import { ResourcesPage } from "./pages/Resources";
import { SettingsPage } from "./pages/Settings";
import { UsagePage } from "./pages/Usage";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<LoginPage />} path="/login" />
        <Route element={<RequireAuth />}>
          <Route element={<Navigate replace to="/dashboard" />} path="/" />
          <Route element={<DashboardPage />} path="/dashboard" />
          <Route element={<PrincipalsPage />} path="/principals" />
          <Route element={<ResourcesPage />} path="/resources" />
          <Route element={<QuotaRulesPage />} path="/quota-rules" />
          <Route element={<UsagePage />} path="/usage" />
          <Route element={<AlertsPage />} path="/alerts" />
          <Route element={<SettingsPage />} path="/settings" />
        </Route>
        <Route element={<Navigate replace to="/dashboard" />} path="*" />
      </Routes>
    </BrowserRouter>
  );
}
