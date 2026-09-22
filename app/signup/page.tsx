"use client";

import { useState } from "react";

export default function SignUpPage() {
const [submitted, setSubmitted] = useState(false);

function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
event.preventDefault();
setSubmitted(true);
}

return ( <main className="min-h-screen bg-slate-50 px-6 py-12"> <div className="mx-auto max-w-md"> <div className="mb-8 text-center"> <div className="text-5xl">🚗</div>

```
      <h1 className="mt-4 text-3xl font-bold text-slate-900">
        Create Your Account
      </h1>

      <p className="mt-2 text-slate-600">
        Find a mobile mechanic when you need one.
      </p>
    </div>

    <div className="rounded-2xl bg-white p-8 shadow-sm">
      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label className="mb-2 block text-sm font-medium text-slate-700">
            First Name
          </label>

          <input
            type="text"
            name="firstName"
            required
            placeholder="John"
            className="w-full rounded-lg border border-slate-300 px-4 py-3 outline-none focus:border-blue-500"
          />
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-slate-700">
            Last Name
          </label>

          <input
            type="text"
            name="lastName"
            required
            placeholder="Smith"
            className="w-full rounded-lg border border-slate-300 px-4 py-3 outline-none focus:border-blue-500"
          />
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-slate-700">
            Phone Number
          </label>

          <input
            type="tel"
            name="phone"
            required
            placeholder="(404) 555-1234"
            className="w-full rounded-lg border border-slate-300 px-4 py-3 outline-none focus:border-blue-500"
          />
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-slate-700">
            Email Address
          </label>

          <input
            type="email"
            name="email"
            required
            placeholder="john@example.com"
            className="w-full rounded-lg border border-slate-300 px-4 py-3 outline-none focus:border-blue-500"
          />
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-slate-700">
            Password
          </label>

          <input
            type="password"
            name="password"
            required
            minLength={6}
            placeholder="Create a password"
            className="w-full rounded-lg border border-slate-300 px-4 py-3 outline-none focus:border-blue-500"
          />
        </div>

        <button
          type="submit"
          className="w-full rounded-lg bg-blue-600 px-4 py-3 font-semibold text-white transition hover:bg-blue-700"
        >
          CREATE ACCOUNT
        </button>
      </form>

      {submitted && (
        <div className="mt-6 rounded-lg bg-green-50 p-4 text-center text-green-700">
          <p className="font-semibold">Account form submitted!</p>
          <p className="mt-1 text-sm">
            Next, we'll connect this form to your Supabase database.
          </p>
        </div>
      )}

      <p className="mt-6 text-center text-sm text-slate-500">
        Already have an account?{" "}
        <button className="font-semibold text-blue-600 hover:underline">
          Sign In
        </button>
      </p>
    </div>
  </div>
</main>

);
}
