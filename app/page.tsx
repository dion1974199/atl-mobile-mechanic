"use client";

import Link from "next/link";

export default function HomePage() {
  return (
    <main className="min-h-screen bg-slate-50">
      <section className="mx-auto max-w-5xl px-6 py-16">
        <div className="text-center">
          <div className="text-6xl">🚗🔧</div>

          <h1 className="mt-6 text-4xl font-bold text-slate-900">
            Mobile Mechanic Marketplace
          </h1>

          <p className="mx-auto mt-4 max-w-2xl text-lg text-slate-600">
            Get connected with mobile mechanics and roadside service
            professionals when your vehicle needs help.
          </p>

          <div className="mt-8 flex flex-wrap justify-center gap-4">
            <Link
              href="/auth/sign-up"
              className="rounded-lg bg-black px-6 py-3 font-semibold text-white"
            >
              Create Account
            </Link>

            <Link
              href="/auth/login"
              className="rounded-lg border border-slate-300 bg-white px-6 py-3 font-semibold text-slate-900"
            >
              Sign In
            </Link>
          </div>
        </div>

        <div className="mt-16 grid gap-6 md:grid-cols-3">
          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-4xl">👤</div>

            <h2 className="mt-4 text-xl font-bold text-slate-900">
              Customers
            </h2>

            <p className="mt-2 text-slate-600">
              Request mobile vehicle service and get help where your
              vehicle is located.
            </p>

            <Link
              href="/requests"
              className="mt-5 inline-block font-semibold text-blue-600"
            >
              Request Service →
            </Link>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-4xl">🔧</div>

            <h2 className="mt-4 text-xl font-bold text-slate-900">
              Mobile Mechanics
            </h2>

            <p className="mt-2 text-slate-600">
              View available service requests, accept jobs, and manage
              accepted work.
            </p>

            <Link
              href="/mechanic"
              className="mt-5 inline-block font-semibold text-blue-600"
            >
              Mechanic Dashboard →
            </Link>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-4xl">🛞</div>

            <h2 className="mt-4 text-xl font-bold text-slate-900">
              Roadside Tire Service
            </h2>

            <p className="mt-2 text-slate-600">
              Roadside tire assistance for cars and commercial trucks,
              including highway and interstate service.
            </p>

            <p className="mt-5 text-sm font-semibold text-slate-500">
              Tire Technician service coming next
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}