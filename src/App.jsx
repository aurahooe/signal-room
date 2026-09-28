import { useEffect, useState } from 'react'
import { supabase, T } from './lib/supabase'

function nextHourMs() {
  const n = new Date()
  n.setMinutes(60, 0, 0)
  return n.getTime() - Date.now()
}
function hourKey(d = new Date()) {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  const h = String(d.getUTCHours()).padStart(2, '0')
  return `${y}-${m}-${day}T${h}`
}
function useCountdown() {
  const [left, setLeft] = useState(nextHourMs())
  useEffect(() => {
    const id = setInterval(() => setLeft(nextHourMs()), 250)
    return () => clearInterval(id)
  }, [])
  const s = Math.max(0, Math.floor(left / 1000))
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${mm}:${ss}`
}
async function ensureProfile(user) {
  const { data } = await supabase.from(T.profiles).select('*').eq('id', user.id).maybeSingle()
  if (data) return data
  const base = (user.email || 'reader').split('@')[0].replace(/[^a-z0-9]/gi, '').slice(0, 16) || 'reader'
  const handle = `${base}${user.id.slice(0, 4)}`
  const row = { id: user.id, handle, display_name: base }
  const { data: created } = await supabase.from(T.profiles).insert(row).select().single()
  return created || { ...row, bio: '' }
}
export default function App() {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [hours, setHours] = useState([])
  const [notes, setNotes] = useState([])
  const [mine, setMine] = useState([])
  const [view, setView] = useState('desk')
  const [toast, setToast] = useState('')
  const [busy, setBusy] = useState(false)
  const count = useCountdown()
  const current = hours[0]
  const older = hours.slice(1, 8)
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])
  useEffect(() => {
    if (!session?.user) { setProfile(null); setMine([]); return }
    ensureProfile(session.user).then(setProfile)
    supabase.from(T.notes).select('*').eq('author_id', session.user.id).order('created_at', { ascending: false }).then(({ data }) => setMine(data || []))
  }, [session])
  async function loadPublic() {
    const [{ data: h }, { data: n }] = await Promise.all([
      supabase.from(T.hours).select('*').order('created_at', { ascending: false }).limit(24),
      supabase.from(T.notes).select('*, signalroom_profiles(handle, display_name)').eq('is_public', true).order('created_at', { ascending: false }).limit(40),
    ])
    setHours(h || [])
    setNotes(n || [])
  }
  useEffect(() => {
    loadPublic()
    const a = supabase.channel('sr-hours').on('postgres_changes', { event: '*', schema: 'public', table: T.hours }, loadPublic).subscribe()
    const b = supabase.channel('sr-notes').on('postgres_changes', { event: '*', schema: 'public', table: T.notes }, loadPublic).subscribe()
    const tick = setInterval(loadPublic, 60000)
    return () => { supabase.removeChannel(a); supabase.removeChannel(b); clearInterval(tick) }
  }, [])
  function flash(msg) { setToast(msg); setTimeout(() => setToast(''), 2600) }
  return (
    <div className="shell">
      <header className="mast">
        <div className="clock"><div className="dial"><div className="hand" /></div><div className="mark">{hourKey()}</div></div>
        <h1 className="wordmark">Signal <em>Room</em></h1>
        <nav className="nav">
          <button className="ghost" onClick={() => setView('desk')}>Desk</button>
          <button className="ghost" onClick={() => setView('table')}>Public table</button>
          {session ? (<><button className="ghost" onClick={() => setView('drawer')}>Drawer</button><button onClick={() => supabase.auth.signOut()}>Sign out</button></>) : (<button className="solid btn" onClick={() => setView('gate')}>Enter</button>)}
        </nav>
      </header>
      {view === 'gate' && <Gate onDone={() => { setView('desk'); flash('You are in the room') }} />}
      {view !== 'gate' && (
        <section className="hero">
          <div>
            <div className="kicker">{current?.kicker || 'Waiting on the next press'}</div>
            <h2 className="edition-title">{current?.title || 'The press is warming.'}</h2>
            <p className="lede">{current?.body || 'A new edition lands on the hour. Until then the table is still open.'}</p>
          </div>
          <aside className="side-card">
            <div className="meta">Next edition in</div>
            <div className="countdown">{count}</div>
            <p className="meta" style={{ marginTop: 16 }}>{profile ? `Signed in as ${profile.display_name}` : 'Guests may read. Members may leave slips.'}</p>
            {!session && <button className="solid btn" style={{ marginTop: 16 }} onClick={() => setView('gate')}>Take a seat</button>}
          </aside>
        </section>
      )}
      {view === 'desk' && (
        <div className="grid">
          <div className="col-8"><div className="kicker">On the table</div><NoteList notes={notes} /></div>
          <div className="col-4">
            <div className="kicker">Earlier hours</div>
            <div className="archive">
              {older.map((h) => (<button key={h.id} onClick={() => flash(h.title)}><strong>{h.title}</strong><div className="meta">{h.hour_key}</div></button>))}
              {!older.length && <p className="meta">This is the first hour.</p>}
            </div>
            {session && profile && <div style={{ marginTop: 28 }}><Composer profile={profile} onSaved={(n) => { setMine((m) => [n, ...m]); if (n.is_public) setNotes((x) => [n, ...x]); flash(n.is_public ? 'On the table' : 'Filed in your drawer') }} busy={busy} setBusy={setBusy} /></div>}
          </div>
        </div>
      )}
      {view === 'table' && (<><div className="kicker">Everything marked public</div><NoteList notes={notes} /></>)}
      {view === 'drawer' && session && (
        <>
          <div className="kicker">Your drawer</div>
          <NoteList notes={mine} mine onChange={async (note, patch) => {
            const { data, error } = await supabase.from(T.notes).update(patch).eq('id', note.id).select('*, signalroom_profiles(handle, display_name)').single()
            if (error) return flash(error.message)
            setMine((rows) => rows.map((r) => r.id === note.id ? data : r))
            loadPublic()
            flash(patch.is_public ? 'Moved to the table' : 'Returned to the drawer')
          }} />
          {profile && <Composer profile={profile} onSaved={(n) => { setMine((m) => [n, ...m]); flash('Saved') }} busy={busy} setBusy={setBusy} />}
        </>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
function NoteList({ notes, mine, onChange }) {
  if (!notes?.length) return <p className="meta">The table is empty for now.</p>
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {notes.map((n, i) => (
        <article className="slip" key={n.id} style={{ animationDelay: `${i * 40}ms` }}>
          <h3>{n.title || 'Untitled slip'}</h3>
          <p>{n.body}</p>
          <footer>
            <span className="meta">{n.signalroom_profiles?.handle ? `@${n.signalroom_profiles.handle}` : mine ? (n.is_public ? 'public' : 'private') : ''} {' · '} {new Date(n.created_at).toLocaleString()}</span>
            {mine && <button className="ghost" onClick={() => onChange(n, { is_public: !n.is_public })}>{n.is_public ? 'Make private' : 'Make public'}</button>}
          </footer>
        </article>
      ))}
    </div>
  )
}
function Composer({ profile, onSaved, busy, setBusy }) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [isPublic, setIsPublic] = useState(true)
  async function submit(e) {
    e.preventDefault()
    if (!body.trim()) return
    setBusy?.(true)
    const payload = { author_id: profile.id, title: title.trim(), body: body.trim(), is_public: isPublic }
    const { data, error } = await supabase.from(T.notes).insert(payload).select('*, signalroom_profiles(handle, display_name)').single()
    setBusy?.(false)
    if (error) return alert(error.message)
    setTitle(''); setBody(''); onSaved(data)
  }
  return (
    <form className="stack" onSubmit={submit}>
      <div className="kicker">Leave a slip</div>
      <label>Title</label>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="A short heading" />
      <label>Body</label>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="What should sit on the table this hour?" />
      <label className="check"><input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} /> Mark public — anyone can read it</label>
      <button className="solid btn" disabled={busy}>{busy ? 'Filing…' : 'File slip'}</button>
    </form>
  )
}
function Gate({ onDone }) {
  const [mode, setMode] = useState('in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  async function submit(e) {
    e.preventDefault(); setErr('')
    const fn = mode === 'in' ? supabase.auth.signInWithPassword({ email, password }) : supabase.auth.signUp({ email, password })
    const { error } = await fn
    if (error) setErr(error.message); else onDone()
  }
  return (
    <section className="hero">
      <div>
        <div className="kicker">The door</div>
        <h2 className="edition-title">{mode === 'in' ? 'Come back in.' : 'Take a key.'}</h2>
        <p className="lede">Email and a password. Public slips go on the table. Private slips stay in your drawer.</p>
      </div>
      <form className="side-card stack" onSubmit={submit}>
        <label>Email</label>
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <label>Password</label>
        <input type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} />
        {err && <p className="meta" style={{ color: 'var(--oxblood)' }}>{err}</p>}
        <button className="solid btn">{mode === 'in' ? 'Enter' : 'Create account'}</button>
        <button type="button" className="ghost" onClick={() => setMode(mode === 'in' ? 'up' : 'in')}>{mode === 'in' ? 'Need a key?' : 'Already have one?'}</button>
      </form>
    </section>
  )
}
