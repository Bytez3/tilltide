import { useRef, useState } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { SetupCard } from '@/components/setup-card'
import { Button } from '@/components/ui'
import { colors, ui } from '@/constants/theme'
import { useMerchant } from '@/features/merchant/merchant-provider'
import { useSignSweep } from '@/features/sweep/use-sweep'
import { api, ChatTurn, Sweep } from '@/lib/api'
import { shortAddress } from '@/lib/format'

/** The API takes up to 40 turns of 4000 characters; keep the most recent and cut long ones. */
const MAX_TURNS = 20
const MAX_CHARS = 4000
function forApi(turns: ChatTurn[]): ChatTurn[] {
  const recent = turns.slice(-MAX_TURNS)
  // The history must start with the user.
  while (recent.length > 1 && recent[0]!.role !== 'user') recent.shift()
  return recent.map((t) => ({ role: t.role, content: t.content.slice(0, MAX_CHARS) }))
}

const SUGGESTIONS = ['What did I take today?', 'Who are my top customers?', 'Reconcile today and suggest a sweep']

export default function AgentScreen() {
  const { merchant } = useMerchant()
  const signSweep = useSignSweep(merchant)
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [sweep, setSweep] = useState<Sweep | null>(null)
  const [draft, setDraft] = useState('')
  const [thinking, setThinking] = useState(false)
  const [signing, setSigning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scroll = useRef<ScrollView>(null)

  if (!merchant) {
    return (
      <View style={[ui.screen, ui.content]}>
        <SetupCard />
      </View>
    )
  }

  async function send(text: string) {
    if (!merchant || !text.trim() || thinking || signing) return
    const next: ChatTurn[] = [...turns, { role: 'user', content: text.trim() }]
    setTurns(next)
    setDraft('')
    setThinking(true)
    setError(null)
    try {
      const { reply, sweeps } = await api.chat(forApi(next))
      setTurns([...next, { role: 'assistant', content: reply }])
      if (sweeps.length) setSweep(sweeps.at(-1)!)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setThinking(false)
      setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50)
    }
  }

  async function confirmSweep() {
    if (!sweep) return
    setSigning(true)
    setError(null)
    try {
      setSweep(await signSweep(sweep))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      // Show the server's view (it may have been submitted before the error).
      setSweep(await api.checkSweep(sweep.id).catch(() => sweep))
    } finally {
      setSigning(false)
    }
  }

  async function checkAgain() {
    if (!sweep) return
    setSweep(await api.checkSweep(sweep.id).catch((e) => (setError(e instanceof Error ? e.message : String(e)), sweep)))
  }

  async function cancelSweep() {
    if (!sweep) return
    try {
      await api.cancelSweep(sweep.id)
      setSweep(null)
    } catch (e) {
      // It may already be on its way; show the real state instead of hiding it.
      setError(e instanceof Error ? e.message : String(e))
      setSweep(await api.checkSweep(sweep.id).catch(() => sweep))
    }
  }

  return (
    <KeyboardAvoidingView style={ui.screen} behavior="padding" keyboardVerticalOffset={90}>
      <ScrollView ref={scroll} contentContainerStyle={ui.content}>
        {turns.length === 0 && (
          <View style={ui.card}>
            <Text style={ui.h2}>Ask about your shop</Text>
            <Text style={ui.muted}>The agent reads your sales and the chain. It can suggest moving takings to you, but only you can approve it.</Text>
            {SUGGESTIONS.map((s) => (
              <Pressable key={s} onPress={() => send(s)} style={[ui.input, { marginTop: 4 }]}>
                <Text style={ui.body}>{s}</Text>
              </Pressable>
            ))}
          </View>
        )}
        {turns.map((turn, i) => (
          <View
            key={i}
            style={[
              ui.card,
              turn.role === 'user'
                ? { alignSelf: 'flex-end', backgroundColor: colors.sea, borderColor: colors.sea, maxWidth: '85%' }
                : { alignSelf: 'flex-start', maxWidth: '92%' },
            ]}
          >
            <Text style={[ui.body, turn.role === 'user' && { color: colors.seaInk }]}>{turn.content}</Text>
          </View>
        ))}
        {thinking && <ActivityIndicator color={colors.sea} style={{ alignSelf: 'flex-start' }} />}
        {sweep && (
          <View style={[ui.card, { borderColor: colors.sea, borderWidth: 1 }]}>
            <Text style={ui.muted}>Proposed sweep</Text>
            {/* Shown exactly as it will be signed. */}
            <Text style={ui.h1}>
              {sweep.display} {sweep.token}
            </Text>
            <Text style={ui.body}>To owner wallet {shortAddress(sweep.toWallet)}</Text>
            <Text style={[ui.muted, { fontFamily: 'monospace' }]} selectable>
              {sweep.toWallet}
            </Text>
            {sweep.reason && <Text style={ui.muted}>{sweep.reason}</Text>}
            {sweep.error && <Text style={[ui.muted, { color: colors.warn }]}>{sweep.error}</Text>}
            {sweep.status === 'submitted' ? (
              <View style={{ gap: 8 }}>
                <View style={ui.row}>
                  {signing && <ActivityIndicator color={colors.sea} />}
                  <Text style={ui.muted}>Sent. Confirming on the chain…</Text>
                </View>
                {!signing && <Button title="Check again" variant="secondary" onPress={checkAgain} />}
              </View>
            ) : sweep.status === 'failed' ? (
              <Text style={{ color: colors.danger, fontWeight: '600' }}>Needs checking. Do not sign again; contact support.</Text>
            ) : sweep.status === 'proposed' ? (
              <View style={ui.row}>
                <Button title="Cancel" variant="secondary" onPress={cancelSweep} style={{ flex: 1 }} />
                <Button title="Confirm & sign" onPress={confirmSweep} loading={signing} style={{ flex: 2 }} />
              </View>
            ) : (
              <Text style={{ color: sweep.status === 'confirmed' ? colors.paid : colors.muted, fontWeight: '600' }}>
                {sweep.status === 'confirmed' ? 'Sent ✓' : 'Cancelled'}
              </Text>
            )}
          </View>
        )}
        {error && <Text style={[ui.muted, { color: colors.danger }]}>{error}</Text>}
      </ScrollView>
      <View style={[ui.row, { padding: 12, borderTopColor: colors.line, borderTopWidth: 1 }]}>
        <TextInput
          style={[ui.input, { flex: 1 }]}
          placeholder="Ask the agent…"
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={() => send(draft)}
          returnKeyType="send"
        />
        <Button title="Send" onPress={() => send(draft)} disabled={!draft.trim() || thinking || signing} style={{ paddingHorizontal: 18 }} />
      </View>
    </KeyboardAvoidingView>
  )
}
