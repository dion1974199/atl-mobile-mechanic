"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export function LoginForm() {
  const supabase = createClient();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  async function handleLogin(
    event: React.FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    setLoading(true);
    setErrorMessage("");

    const { data, error } =
      await supabase.auth.signInWithPassword({
        email,
        password,
      });

    if (error) {
      setErrorMessage(error.message);
      setLoading(false);
      return;
    }

    if (!data.user) {
      setErrorMessage("Unable to sign in.");
      setLoading(false);
      return;
    }

    const role = data.user.user_metadata?.role;

    if (role === "customer") {
      window.location.href = "/requests";
      return;
    }

    if (role === "mechanic") {
      window.location.href = "/mechanic";
      return;
    }

    if (role === "tire_technician") {
      window.location.href = "/tire-technician";
      return;
    }

    window.location.href = "/protected";
  }

  return (
    <div className="w-full max-w-md rounded-xl border-4 border-black bg-white p-8 text-black shadow-2xl">
      <h1 className="text-3xl font-black text-black">
        Sign In
      </h1>

      <p className="mt-3 text-lg font-bold text-black">
        Sign in to your Mobile Mechanic account.
      </p>

      <form
        onSubmit={handleLogin}
        className="mt-6 space-y-6"
      >
        <div>
          <label
            htmlFor="email"
            className="block text-lg font-black text-black"
          >
            Email
          </label>

          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) =>
              setEmail(event.target.value)
            }
            placeholder="Enter your email"
            className="mt-2 w-full rounded-md border-4 border-black bg-white p-3 text-lg font-bold text-black placeholder:text-gray-700"
          />
        </div>

        <div>
          <label
            htmlFor="password"
            className="block text-lg font-black text-black"
          >
            Password
          </label>

          <input
            id="password"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(event) =>
              setPassword(event.target.value)
            }
            placeholder="Enter your password"
            className="mt-2 w-full rounded-md border-4 border-black bg-white p-3 text-lg font-bold text-black placeholder:text-gray-700"
          />
        </div>

        {errorMessage && (
          <div className="rounded-md border-4 border-red-700 bg-white p-3 text-lg font-bold text-red-800">
            {errorMessage}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md border-4 border-black bg-black px-4 py-3 text-lg font-black text-white"
        >
          {loading ? "Signing in..." : "Sign In"}
        </button>
      </form>

      <p className="mt-6 text-center text-base font-bold text-black">
        Don&apos;t have an account?{" "}
        <a
          href="/auth/sign-up"
          className="font-black text-black underline"
        >
          Sign up
        </a>
      </p>
    </div>
  );
}