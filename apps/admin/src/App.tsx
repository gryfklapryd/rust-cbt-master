import { createBrowserRouter, Navigate, RouterProvider, useParams } from "react-router";
import { Layout } from "./components/Layout";
import { Loading } from "./components/ui";
import { useAuth } from "./lib/auth";
import { AssetsPage } from "./pages/Assets";
import { BankDetailPage, BanksPage } from "./pages/Banks";
import { DashboardPage } from "./pages/Dashboard";
import { ExamDetailPage, ExamsPage } from "./pages/Exams";
import { GradingPage } from "./pages/Grading";
import { LoginPage } from "./pages/Login";
import { ParticipantsPage } from "./pages/Participants";
import { QuestionEditorPage } from "./pages/QuestionEditor";
import { AttemptDetailPage, ResultsPage } from "./pages/Results";
import { ScheduleDetailPage, SchedulesPage } from "./pages/Schedules";
import { SitesPage } from "./pages/Sites";
import { SyncPage } from "./pages/Sync";
import { UsersPage } from "./pages/Users";

/** Remount editor saat berpindah soal agar state form tidak terbawa. */
function QuestionEditorRoute() {
  const { questionId } = useParams();
  return <QuestionEditorPage key={questionId ?? "new"} />;
}

const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: "sites", element: <SitesPage /> },
      { path: "participants", element: <ParticipantsPage /> },
      { path: "banks", element: <BanksPage /> },
      { path: "banks/:bankId", element: <BankDetailPage /> },
      { path: "banks/:bankId/questions/new", element: <QuestionEditorRoute /> },
      { path: "banks/:bankId/questions/:questionId", element: <QuestionEditorRoute /> },
      { path: "assets", element: <AssetsPage /> },
      { path: "exams", element: <ExamsPage /> },
      { path: "exams/:examId", element: <ExamDetailPage /> },
      { path: "schedules", element: <SchedulesPage /> },
      { path: "schedules/:scheduleId", element: <ScheduleDetailPage /> },
      { path: "results", element: <ResultsPage /> },
      { path: "results/:attemptId", element: <AttemptDetailPage /> },
      { path: "grading", element: <GradingPage /> },
      { path: "sync", element: <SyncPage /> },
      { path: "users", element: <UsersPage /> },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);

export function App() {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  if (!user) return <LoginPage />;
  return <RouterProvider router={router} />;
}
