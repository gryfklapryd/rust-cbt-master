import { NavLink, Outlet } from "react-router";
import { useAuth, type Role } from "../lib/auth";

const NAV: { to: string; label: string; icon: string; roles?: Role[] }[] = [
  { to: "/", label: "Dasbor", icon: "◧" },
  { to: "/sites", label: "Titik Ujian", icon: "⌂" },
  { to: "/participants", label: "Peserta", icon: "☺" },
  { to: "/banks", label: "Bank Soal", icon: "☰", roles: ["author"] },
  { to: "/assets", label: "Media", icon: "▣", roles: ["author"] },
  { to: "/exams", label: "Ujian", icon: "✎", roles: ["author"] },
  { to: "/schedules", label: "Jadwal", icon: "◷" },
  { to: "/results", label: "Hasil", icon: "▤" },
  { to: "/grading", label: "Koreksi", icon: "✔", roles: ["grader"] },
  { to: "/sync", label: "Sinkronisasi", icon: "⇅" },
  { to: "/users", label: "Pengguna", icon: "⚙", roles: ["admin"] },
];

const ROLE_LABEL: Record<Role, string> = { admin: "Administrator", author: "Penulis soal", grader: "Korektor", proctor: "Pengawas" };

export function Layout() {
  const { user, logout, can } = useAuth();
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-logo">CBT</span>
          <span>Server Pusat</span>
        </div>
        <nav>
          {NAV.filter((n) => !n.roles || can(...n.roles)).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === "/"} className={({ isActive }) => `nav-link${isActive ? " is-active" : ""}`}>
              <span className="nav-icon" aria-hidden>
                {n.icon}
              </span>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div>
            <strong>{user?.name}</strong>
            <div className="muted small">{user ? ROLE_LABEL[user.role] : ""}</div>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={logout}>
            Keluar
          </button>
        </div>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
