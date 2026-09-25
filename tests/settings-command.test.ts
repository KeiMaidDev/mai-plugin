import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from 'koishi'
import { registerSettingsCommands } from '../src/commands/settings'
import type { CoreCommandDependencies } from '../src/commands/support'
import { InvalidSettingError } from '../src/services/setting-service'

function commandActions() {
  const actions = new Map<string, (...args: any[]) => any>()
  let commandName = ''
  const chain = {
    alias() { return this },
    action(callback: (...args: any[]) => any) {
      actions.set(commandName, callback)
      return this
    },
  }
  const context = {
    command(name: string) {
      commandName = name
      return chain
    },
  } as unknown as Context
  return { context, actions }
}

for (const [command, label, method] of [
  ['mai.avatar <value:text>', '头像', 'setAvatar'],
  ['mai.plate <value:text>', '牌子', 'setPlate'],
] as const) {
  test(`${label} command shows collection guidance for missing or unknown values`, async () => {
    const expectedText = label === '头像'
      ? '\n使用方法：设置头像 <id/名称>\n\t例：设置头像 106103\n\t例：设置头像 高瀬 梨緒\n\n\t收藏品列表：https://otmdb.cn/bot/maimai/icons'
      : '\n使用方法：设置牌子/设置姓名框 id/名称\n\t例：设置牌子 100501\n\t例：设置牌子 晓将\n\t例：设置姓名框 7sRefちほー2\n\n\t牌子列表：https://otmdb.cn/bot/maimai/plates'
    const expectedRich = label === '头像'
      ? '**设置头像**\n\n使用方法：设置头像 id/名称\n👉设置头像 106103\n👉设置头像 高瀬 梨緒\n \n⏬您可以点击下方按钮查看头像列表。'
      : '**设置牌子**\n\n使用方法：设置牌子/设置姓名框 id/名称\n👉设置牌子 100501\n👉设置牌子 晓将\n👉设置姓名框 7sRefちほー2\n \n⏬您可以点击下方按钮查看牌子列表。'
    const { context, actions } = commandActions()
    const saved: string[] = []
    const sent: unknown[] = []
    const dependencies = {
      settingService: {
        [method]: async (_userId: string, value: string) => {
          if (value === 'unknown') {
            throw new InvalidSettingError(method === 'setAvatar' ? 'avatar' : 'plate', value)
          }
          saved.push(value)
        },
        isCompatibilityMode: async () => false,
      },
    } as unknown as CoreCommandDependencies
    registerSettingsCommands(context, dependencies)
    const action = actions.get(command)
    assert.ok(action)
    for (const value of [undefined, '   ']) {
      await action({
        options: {},
        session: {
          userId: '1', channelId: '2', platform: 'test', content: command,
          send: async (message: unknown) => { sent.push(message) },
        },
      }, value)
    }
    assert.deepEqual(saved, [])
    assert.equal(sent.length, 2)
    await action({
      options: {},
      session: {
        userId: '1', channelId: '2', platform: 'test', content: command,
        send: async (message: unknown) => { sent.push(message) },
      },
    }, 'unknown')
    assert.deepEqual(saved, [])
    assert.equal(sent.length, 3)
    for (const message of sent) {
      assert.equal((message as any[])[0].attrs.content, expectedText)
    }

    let rich: any
    await action({
      options: {},
      session: {
        userId: '1', channelId: '2', platform: 'qq', content: command,
        send: async (message: unknown) => { rich = message },
      },
    })
    assert.equal(rich.attrs.markdown.content, expectedRich)
    const buttons = rich.attrs.keyboard.content.rows[0].buttons
    assert.deepEqual(buttons.map((button: any) => button.render_data.label), [
      `选择${label}`, `⚙ 设置${label}`,
    ])
    assert.equal(buttons[0].action.data, `https://otmdb.cn/bot/maimai/${label === '头像' ? 'icons' : 'plates'}`)
    assert.equal(buttons[1].action.data, `/mai 设置${label} `)

    await action({
      options: {},
      session: {
        userId: '1', channelId: '2', platform: 'test', content: command,
        send: async (message: unknown) => { sent.push(message) },
      },
    }, '123')
    assert.deepEqual(saved, ['123'])
    assert.match(JSON.stringify(sent.at(-1)), new RegExp(`设置${label}成功`))

    await action({
      options: {},
      session: {
        userId: '1', channelId: '2', platform: 'qq', content: command,
        send: async (message: unknown) => { rich = message },
      },
    }, '123')
    assert.equal(rich.attrs.markdown.content, `**设置${label}**\n\n设置${label}成功。`)
    assert.deepEqual(rich.attrs.keyboard.content.rows[0].buttons.map((button: any) => button.render_data.label), [
      `选择${label}`, `⚙ 设置${label}`,
    ])
  })
}
