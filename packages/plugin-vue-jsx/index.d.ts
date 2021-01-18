import { Plugin } from 'vite'
import { VueJSXPluginOptions } from '@vue/babel-plugin-jsx'

export type Options = VueJSXPluginOptions

declare function createPlugin(options?: Options): Plugin

export default createPlugin
