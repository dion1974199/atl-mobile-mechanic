"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

export function SignUpForm() {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState("customer");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");

  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    const supabase = createClient();

    const { data, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/protected`,
        data: {
          first_name: firstName,
          last_name: lastName,
          phone: phone,
          role: role,
        },
      },
    });

    console.log("SIGNUP DATA:", data);
    console.log("SIGNUP ERROR:", signUpError);

    if (signUpError) {
      setError(signUpError.message);
      return;
    }

    if (!data.user) {
      setError("Supabase did not create the user.");
      return;
    }

    router.push("/auth/sign-up-success");
  }

  return (
    <div className="rounded-lg border bg-white p-6 shadow-sm">
      <h1 className="text-2xl font-bold">
        Create Your Account
      </h1>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <div>
          <label className="block font-medium">First Name</label>
          <input
            className="mt-1 w-full rounded border p-2"
            required
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
          />
        </div>

        <div>
          <label className="block font-medium">Last Name</label>
          <input
            className="mt-1 w-full rounded border p-2"
            required
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
          />
        </div>

        <div>
          <label className="block font-medium">Phone Number</label>
          <input
            className="mt-1 w-full rounded border p-2"
            type="tel"
            required
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>

        <div>
          <label className="block font-medium">Account Type</label>

          <select
            className="mt-1 w-full rounded border p-2"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            <option value="customer">Customer</option>
            <option value="mechanic">Mechanic</option>
            <option value="tire_technician">Tire Technician</option>
          </select>
        </div>

        <div>
          <label className="block font-medium">Email</label>
          <input
            className="mt-1 w-full rounded border p-2"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div>
          <label className="block font-medium">Password</label>
          <input
            className="mt-1 w-full rounded border p-2"
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <div>
          <label className="block font-medium">Confirm Password</label>
          <input
            className="mt-1 w-full rounded border p-2"
            type="password"
            required
            minLength={6}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
        </div>

        {error && (
          <p className="text-sm text-red-600">
            {error}
          </p>
        )}

        <button
          type="submit"
          className="w-full rounded bg-black p-3 font-semibold text-white"
        >
          CREATE ACCOUNT
        </button>
      </form>
    </div>
  );
}