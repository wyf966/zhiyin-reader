import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { ApiError, api, type UserInfo } from '../api/client'
import { authStore } from '../api/authStore'

interface SessionValue {
  user: UserInfo | null
  /** 静默恢复是否已完成。未完成时页面不要急着跳登录页 */
  ready: boolean
  recoveryError: string
  retrySession: () => Promise<void>
  login: (account: string, password: string) => Promise<UserInfo>
  register: (account: string, password: string, nickname?: string) => Promise<void>
  logout: () => Promise<void>
  /** 重新拉一次当前用户（改完昵称或头像后用），失败静默 */
  refreshUser: () => Promise<void>
}

const Ctx = createContext<SessionValue | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserInfo | null>(null)
  const [ready, setReady] = useState(false)
  const [recoveryError, setRecoveryError] = useState('')

  const retrySession = useCallback(async () => {
    if (!authStore.refresh) return
    let expectedAccess = authStore.access
    let expectedRefresh = authStore.refresh
    try {
      if (await api.silentLogin()) {
        const token = authStore.access
        expectedAccess = token
        expectedRefresh = authStore.refresh
        const me = await api.me()
        if (authStore.access !== token) return
        authStore.setUser(me.userId)
        setUser(me)
        setRecoveryError('')
      }
    } catch (e) {
      // 恢复期间可能已经手动登录或退出，迟到的失败不能清除新会话。
      if (authStore.access !== expectedAccess || authStore.refresh !== expectedRefresh) return
      if (e instanceof ApiError && e.status === 401) authStore.clear()
      else setRecoveryError('暂时无法恢复登录，登录凭据已保留。网络恢复后可重试。')
    } finally {
      setReady(true)
    }
  }, [])

  /**
   * 刷新页面后 accessToken（在内存里）丢了，但 localStorage 里还有刷新令牌。
   * 这里静默换一次新的访问令牌，再取用户信息，把登录态恢复出来。
   */
  useEffect(() => {
    void retrySession().finally(() => setReady(true))
    const online = () => { if (!authStore.userId) void retrySession() }
    window.addEventListener('online', online)
    return () => {
      window.removeEventListener('online', online)
    }
  }, [retrySession])

  const login = useCallback(async (account: string, password: string) => {
    const r = await api.login({ account, password })
    authStore.set(r)
    authStore.setUser(r.user.userId)
    setUser(r.user)
    return r.user
  }, [])

  const register = useCallback(
    async (account: string, password: string, nickname?: string) => {
      // 契约 §3.1：注册不签发令牌，注册成功后直接调登录接口
      await api.register({ account, password, nickname })
      await login(account, password)
    },
    [login],
  )

  const logout = useCallback(async () => {
    const rt = authStore.refresh
    if (rt) {
      try {
        await api.logout(rt)
      } catch {
        /* 令牌可能早已失效，忽略 */
      }
    }
    authStore.clear()
    setUser(null)
  }, [])

  const refreshUser = useCallback(async () => {
    try {
      const me = await api.me()
      setUser({
        userId: me.userId,
        account: me.account,
        nickname: me.nickname,
        avatarUrl: me.avatarUrl,
      })
      authStore.setUser(me.userId)
    } catch {
      // 拉不到就维持现状：这是刷新副本，不是关键路径，不该把界面搞崩
    }
  }, [])

  return (
    <Ctx.Provider value={{ user, ready, recoveryError, retrySession, login, register, logout, refreshUser }}>
      {children}
    </Ctx.Provider>
  )
}

export function useSession(): SessionValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useSession 必须在 SessionProvider 内使用')
  return v
}
