import { useState } from 'react';
import { api } from './api';

export default function Login({ onLogin }) {
  const [tab, setTab] = useState('signin'); // signin | register | forgot
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#0a1f44] via-[#13294b] to-slate-900 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="bg-[#0a1f44] text-white px-8 py-6 text-center">
          <h1 className="text-2xl font-bold">Productivity Tracker</h1>
          <p className="text-sm text-slate-300 mt-1">
            {tab === 'signin' && 'Sign in to your account'}
            {tab === 'register' && 'Create a new account'}
            {tab === 'forgot' && 'Reset your password'}
          </p>
        </div>

        <div className="flex border-b text-sm">
          <TabBtn active={tab === 'signin' || tab === 'forgot'} onClick={() => setTab('signin')}>Sign in</TabBtn>
          <TabBtn active={tab === 'register'} onClick={() => setTab('register')}>Register</TabBtn>
        </div>

        <div className="p-8">
          {tab === 'signin' && <SignInForm onLogin={onLogin} switchTo={setTab} />}
          {tab === 'register' && <RegisterForm onLogin={onLogin} />}
          {tab === 'forgot' && <ForgotForm switchTo={setTab} />}
        </div>
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 py-3 font-medium transition ${
        active
          ? 'text-[#0a1f44] border-b-2 border-[#0a1f44] bg-slate-50'
          : 'text-slate-500 hover:text-slate-700'
      }`}
    >
      {children}
    </button>
  );
}

function Field({ label, type = 'text', value, onChange, autoFocus, hint }) {
  return (
    <div>
      <label className="text-xs font-medium text-slate-600">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
        className="w-full border rounded-md px-3 py-2 mt-1 focus:outline-none focus:ring-2 focus:ring-[#0a1f44]"
      />
      {hint && <div className="text-xs text-slate-400 mt-1">{hint}</div>}
    </div>
  );
}

function Alert({ kind, children }) {
  if (!children) return null;
  const map = {
    error: 'text-red-700 bg-red-50 border-red-200',
    info: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  };
  return (
    <div className={`text-sm border rounded-md p-2 ${map[kind]}`}>{children}</div>
  );
}

function PrimaryBtn({ busy, children, ...rest }) {
  return (
    <button
      disabled={busy}
      className="w-full bg-[#0a1f44] hover:bg-[#13294b] disabled:opacity-50 text-white font-medium rounded-md py-2 transition"
      {...rest}
    >
      {busy ? 'Working…' : children}
    </button>
  );
}

function SignInForm({ onLogin, switchTo }) {
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const r = await api.login(u, p);
      onLogin(r.user);
    } catch (e) {
      setErr(e.message === 'Unauthorized' ? 'Invalid username or password' : e.message);
    } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Username" value={u} onChange={setU} autoFocus />
      <Field label="Password" type="password" value={p} onChange={setP} />
      <Alert kind="error">{err}</Alert>
      <PrimaryBtn busy={busy}>Sign in</PrimaryBtn>
      <div className="text-center pt-1">
        <button type="button" onClick={() => switchTo('forgot')}
          className="text-xs text-[#0a1f44] hover:underline">
          Forgot your password?
        </button>
      </div>
    </form>
  );
}

function ForgotForm({ switchTo }) {
  const [step, setStep] = useState('request'); // request | confirm
  const [u, setU] = useState('');
  const [token, setToken] = useState('');
  const [pwd, setPwd] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');

  const requestSubmit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await api.requestReset(u);
      setInfo('If that account exists, a reset token has been issued. Ask your admin for the token, then enter it below.');
      setStep('confirm');
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const confirmSubmit = async (e) => {
    e.preventDefault();
    if (pwd.length < 8) return setErr('Password must be at least 8 characters');
    setBusy(true); setErr('');
    try {
      await api.confirmReset(token, pwd);
      setInfo('Password updated. You can now sign in.');
      setTimeout(() => switchTo('signin'), 1500);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  if (step === 'request') {
    return (
      <form onSubmit={requestSubmit} className="space-y-4">
        <Field label="Username" value={u} onChange={setU} autoFocus
          hint="We'll generate a single-use reset token." />
        <Alert kind="error">{err}</Alert>
        <PrimaryBtn busy={busy}>Send reset token</PrimaryBtn>
        <div className="text-center">
          <button type="button" onClick={() => switchTo('signin')}
            className="text-xs text-[#0a1f44] hover:underline">
            Back to sign in
          </button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={confirmSubmit} className="space-y-4">
      <Alert kind="info">{info}</Alert>
      <Field label="Reset token" value={token} onChange={setToken} autoFocus />
      <Field label="New password" type="password" value={pwd} onChange={setPwd}
        hint="At least 8 characters." />
      <Alert kind="error">{err}</Alert>
      <PrimaryBtn busy={busy}>Set new password</PrimaryBtn>
      <div className="text-center">
        <button type="button" onClick={() => switchTo('signin')}
          className="text-xs text-[#0a1f44] hover:underline">
          Back to sign in
        </button>
      </div>
    </form>
  );
}

function RegisterForm({ onLogin }) {
  const [u, setU] = useState('');
  const [name, setName] = useState('');
  const [p, setP] = useState('');
  const [c, setC] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (p !== c) return setErr('Passwords do not match');
    if (p.length < 8) return setErr('Password must be at least 8 characters');
    setBusy(true);
    try {
      const r = await api.register(u, p, name);
      onLogin(r.user);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Username" value={u} onChange={setU} autoFocus
        hint="3+ chars, letters / numbers / underscore." />
      <Field label="Display name" value={name} onChange={setName}
        hint="Shown to your supervisor on assigned tasks." />
      <Field label="Password" type="password" value={p} onChange={setP}
        hint="At least 8 characters." />
      <Field label="Confirm password" type="password" value={c} onChange={setC} />
      <Alert kind="error">{err}</Alert>
      <PrimaryBtn busy={busy}>Create account</PrimaryBtn>
      <p className="text-xs text-slate-400 text-center">
        New accounts are created with the Worker role. Contact an admin for supervisor access.
      </p>
    </form>
  );
}

