import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { ApiError, api, getApiBase, type UserInfo } from '../api/client'
import { authStore } from '../api/authStore'

interface SessionValue {
  user: UserInfo | null
  /** 静默恢复是否已完成。未完成时页面不要急着跳登录页 */
  ready: boolean
  /** 当前是否处于断网恢复的离线只读会话 */
  offline: boolean
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
  const [offline, setOffline] = useState(false)
  const [recoveryError, setRecoveryError] = useState('')

  const persistSnapshot = useCallback((info: UserInfo) => {
    authStore.setCachedUser({
      apiBase: getApiBase(),
      userId: info.userId,
      account: info.account,
      nickname: info.nickname,
      avatarUrl: info.avatarUrl,
    })
  }, [])

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
        persistSnapshot(me)
        setUser(me)
        setOffline(false)
        setRecoveryError('')
      }
    } catch (e) {
      // 恢复期间可能已经手动登录或退出，迟到的失败不能清除新会话。
      if (authStore.access !== expectedAccess || authStore.refresh !== expectedRefresh) return
      if (e instanceof ApiError && e.status === 401) {
        authStore.clear()
        setUser(null)
        setOffline(false)
      } else {
        // 断网或服务端暂不可达且本地保留着刷新令牌：允许以离线只读态恢复当前读者，
        // 这样读者可以在断网后直接从「离线文档」重新打开已下载书籍。
        const cached = authStore.getCachedUser(getApiBase())
        if (e instanceof ApiError && e.status === 0 && cached) {
          authStore.setUser(cached.userId)
          setUser({
            userId: cached.userId,
            account: cached.account,
            nickname: cached.nickname,
            avatarUrl: cached.avatarUrl,
          })
          setOffline(true)
          setRecoveryError('')
        } else {
          setRecoveryError('暂时无法恢复登录，登录凭据已保留。网络恢复后可重试。')
        }
      }
    } finally {
      setReady(true)
    }
  }, [persistSnapshot])

  /**
   * 刷新页面后 accessToken（在内存里）丢了，但 localStorage 里还有刷新令牌。
   * 这里静默换一次新的访问令牌，再取用户信息，把登录态恢复出来。
   */
  useEffect(() => {
    void retrySession().finally(() => setReady(true))
    const online = () => {
      if (!authStore.access && authStore.refresh) void retrySession()
    }
    window.addEventListener('online', online)
    return () => {
      window.removeEventListener('online', online)
    }
  }, [retrySession])

  const login = useCallback(async (account: string, password: string) => {
    const r = await api.login({ account, password })
    authStore.set(r)
    authStore.setUser(r.user.userId)
    persistSnapshot(r.user)
    setUser(r.user)
    setOffline(false)
    return r.user
  }, [persistSnapshot])

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
    setOffline(false)
  }, [])

  const refreshUser = useCallback(async () => {
    try {
      const me = await api.me()
      const info: UserInfo = {
        userId: me.userId,
        account: me.account,
        nickname: me.nickname,
        avatarUrl: me.avatarUrl,
      }
      setUser(info)
      authStore.setUser(me.userId)
      persistSnapshot(info)
      setOffline(false)
    } catch {
      // 拉不到就维持现状：这是刷新副本，不是关键路径，不该把界面搞崩
    }
  }, [persistSnapshot])

  return (
    <Ctx.Provider value={{ user, ready, offline, recoveryError, retrySession, login, register, logout, refreshUser }}>
      {children}
    </Ctx.Provider>
  )
}

export function useSession(): SessionValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useSession 必须在 SessionProvider 内使用')
  return v
}
