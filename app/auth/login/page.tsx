import { LoginForm } from "@/components/login-form";

export default function LoginPage() {
  return (
    <main className="min-h-screen bg-black px-4 py-12">
      <div className="mx-auto flex min-h-[80vh] max-w-md items-center justify-center">
        <LoginForm />
      </div>
    </main>
  );
}