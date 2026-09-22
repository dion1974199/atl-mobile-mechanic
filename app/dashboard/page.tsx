"use client";
import { useState } from "react";
export default function DashboardPage() {
const [message, setMessage] = useState("");
const handleAction = (action: string) => {
setMessage(action);
};
return (
<main className="min-h-screen bg-slate-50">
{/* Header */}
<header className="border-b bg-white">
<div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
<div>
<h1 className="text-2xl font-bold text-slate-900">
ATL Mobile Mechanic
</h1>
        <p className="text-sm text-slate-500">
          Customer Dashboard
        </p>
      </div>

      <button
        onClick={() => handleAction("Sign out selected")}
        className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-50"
      >
        Sign Out
      </button>
    </div>
  </header>

  {/* Main Content */}
  <section className="mx-auto max-w-6xl px-6 py-10">
    <div className="mb-10">
      <h2 className="text-3xl font-bold text-slate-900">
        Welcome to ATL Mobile Mechanic! 👋
      </h2>

      <p className="mt-2 text-slate-600">
        What can we help you with today?
      </p>
    </div>

    {/* Emergency Button */}
    <button
      onClick={() => handleAction("Emergency roadside assistance selected")}
      className="mb-8 w-full rounded-2xl bg-red-600 p-6 text-left text-white shadow-lg transition hover:bg-red-700"
    >
      <div className="text-4xl">🚨</div>

      <h3 className="mt-3 text-2xl font-bold">
        Emergency Roadside Help
      </h3>

      <p className="mt-1 text-red-100">
        Need help right now? Request immediate roadside assistance.
      </p>
    </button>

    {/* Main Services */}
    <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">

      <button
        onClick={() => handleAction("Request a Mechanic selected")}
        className="rounded-2xl bg-white p-6 text-left shadow-sm transition hover:shadow-md"
      >
        <div className="text-4xl">🔧</div>

        <h3 className="mt-4 text-lg font-bold text-slate-900">
          Request a Mechanic
        </h3>

        <p className="mt-2 text-sm text-slate-500">
          Tell us what's wrong and find a mechanic.
        </p>
      </button>

      <button
        onClick={() => handleAction("My Vehicles selected")}
        className="rounded-2xl bg-white p-6 text-left shadow-sm transition hover:shadow-md"
      >
        <div className="text-4xl">🚙</div>

        <h3 className="mt-4 text-lg font-bold text-slate-900">
          My Vehicles
        </h3>

        <p className="mt-2 text-sm text-slate-500">
          Add and manage your vehicles.
        </p>
      </button>

      <button
        onClick={() => handleAction("Service Requests selected")}
        className="rounded-2xl bg-white p-6 text-left shadow-sm transition hover:shadow-md"
      >
        <div className="text-4xl">📋</div>

        <h3 className="mt-4 text-lg font-bold text-slate-900">
          Service Requests
        </h3>

        <p className="mt-2 text-sm text-slate-500">
          View your current and past services.
        </p>
      </button>

      <button
        onClick={() => handleAction("Reviews selected")}
        className="rounded-2xl bg-white p-6 text-left shadow-sm transition hover:shadow-md"
      >
        <div className="text-4xl">⭐</div>

        <h3 className="mt-4 text-lg font-bold text-slate-900">
          My Reviews
        </h3>

        <p className="mt-2 text-sm text-slate-500">
          Review mechanics after your service.
        </p>
      </button>
    </div>

    {/* Temporary Action Message */}
    {message && (
      <div className="mt-8 rounded-xl border border-blue-200 bg-blue-50 p-5">
        <p className="font-semibold text-blue-900">
          {message}
        </p>

        <p className="mt-1 text-sm text-blue-700">
          We'll connect this button to its real feature next.
        </p>
      </div>
    )}
  </section>
</main>
);
}