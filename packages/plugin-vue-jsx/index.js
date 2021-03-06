const fs = require('fs')
const babel = require('@babel/core')
const jsx = require('@vue/babel-plugin-jsx')
const importMeta = require('@babel/plugin-syntax-import-meta')
const hash = require('hash-sum')

const ssrRegisterHelperId = '/__vue-jsx-ssr-register-helper'
const ssrRegisterHelperCode =
  `import { useSSRContext } from "vue"\n` +
  `export ${ssrRegisterHelper.toString()}`

/**
 * This function is serialized with toString() and evaluated as a virtual
 * module during SSR
 * @param {import('vue').ComponentOptions} comp
 * @param {string} filename
 */
function ssrRegisterHelper(comp, filename) {
  const setup = comp.setup
  comp.setup = (props, ctx) => {
    // @ts-ignore
    const ssrContext = useSSRContext()
    ;(ssrContext.modules || (ssrContext.modules = new Set())).add(filename)
    if (setup) {
      return setup(props, ctx)
    }
  }
}

/**
 * @param {import('@vue/babel-plugin-jsx').VueJSXPluginOptions} options
 * @returns {import('vite').Plugin}
 */
function tsPlugin(options = {}) {
  let needHmr = false
  let needSourceMap = true
  let tsconfig

  return {
    name: 'vue-jsx',

    config(config) {
      return {
        // jsx and tsx? are handled by this plugin
        // disable esbuild
        esbuild: false,
        define: {
          __VUE_OPTIONS_API__: true,
          __VUE_PROD_DEVTOOLS__: false,
          ...config.define
        }
      }
    },

    configResolved(config) {
      needHmr = config.command === 'serve' && !config.isProduction
      needSourceMap = config.command === 'serve' || !!config.build.sourcemap
    },

    resolveId(id) {
      if (id === ssrRegisterHelperId) {
        return id
      }
    },

    load(id) {
      if (id === ssrRegisterHelperId) {
        return ssrRegisterHelperCode
      }
    },

    transform(code, id, ssr) {
      if (/\.(jsx|tsx?)$/.test(id)) {
        if (/\.tsx?/.test(id)) {
          const ts = require('typescript')
          if (!tsconfig) {
            const configPath = ts.findConfigFile(
              './',
              ts.sys.fileExists,
              'tsconfig.json'
            )
            if (!configPath) {
              throw new Error("Could not find a valid 'tsconfig.json'.")
            }
            const { config, error } = ts.readConfigFile(configPath, (path) =>
              fs.readFileSync(path, 'utf8')
            )
            if (error) throw new Error(error.messageText)
            tsconfig = config
            Object.assign(tsconfig.compilerOptions, {
              sourceMap: false,
              inlineSourceMap: needSourceMap,
              inlineSources: needSourceMap
            })
          }
          const { outputText, diagnostics } = ts.transpileModule(code, {
            compilerOptions: tsconfig.compilerOptions,
            fileName: id,
            reportDiagnostics: true
          })
          if (diagnostics?.[0]) throw new Error(diagnostics[0].messageText)
          code = outputText
        }

        /** @type {any[]} */
        const plugins = [importMeta]
        if (id.endsWith('x')) plugins.push([jsx, options])

        const result = babel.transformSync(code, {
          ast: true,
          plugins,
          sourceMaps: needSourceMap,
          sourceFileName: id
        })

        if (!ssr && !needHmr) {
          return {
            code: result.code,
            map: result.map
          }
        }

        // check for hmr injection
        /**
         * @type {{ name: string }[]}
         */
        const declaredComponents = []
        /**
         * @type {{
         *  local: string,
         *  exported: string,
         *  id: string,
         * }[]}
         */
        const hotComponents = []
        let hasDefault = false

        for (const node of result.ast.program.body) {
          if (node.type === 'VariableDeclaration') {
            const names = parseComponentDecls(node, code)
            if (names.length) {
              declaredComponents.push(...names)
            }
          }

          if (node.type === 'ExportNamedDeclaration') {
            if (
              node.declaration &&
              node.declaration.type === 'VariableDeclaration'
            ) {
              hotComponents.push(
                ...parseComponentDecls(node.declaration, code).map(
                  ({ name }) => ({
                    local: name,
                    exported: name,
                    id: hash(id + name)
                  })
                )
              )
            } else if (node.specifiers.length) {
              for (const spec of node.specifiers) {
                if (
                  spec.type === 'ExportSpecifier' &&
                  spec.exported.type === 'Identifier'
                ) {
                  const matched = declaredComponents.find(
                    ({ name }) => name === spec.local.name
                  )
                  if (matched) {
                    hotComponents.push({
                      local: spec.local.name,
                      exported: spec.exported.name,
                      id: hash(id + spec.exported.name)
                    })
                  }
                }
              }
            }
          }

          if (node.type === 'ExportDefaultDeclaration') {
            if (node.declaration.type === 'Identifier') {
              const _name = node.declaration.name
              const matched = declaredComponents.find(
                ({ name }) => name === _name
              )
              if (matched) {
                hotComponents.push({
                  local: node.declaration.name,
                  exported: 'default',
                  id: hash(id + 'default')
                })
              }
            } else if (isDefineComponentCall(node.declaration)) {
              hasDefault = true
              hotComponents.push({
                local: '__default__',
                exported: 'default',
                id: hash(id + 'default')
              })
            }
          }
        }

        if (hotComponents.length) {
          if (needHmr && !ssr) {
            let code = result.code
            if (hasDefault) {
              code =
                code.replace(
                  /export default defineComponent/g,
                  `const __default__ = defineComponent`
                ) + `\nexport default __default__`
            }

            let callbackCode = ``
            for (const { local, exported, id } of hotComponents) {
              code +=
                `\n${local}.__hmrId = "${id}"` +
                `\n__VUE_HMR_RUNTIME__.createRecord("${id}", ${local})`
              callbackCode += `\n__VUE_HMR_RUNTIME__.reload("${id}", __${exported})`
            }

            code += `\nimport.meta.hot.accept(({${hotComponents
              .map((c) => `${c.exported}: __${c.exported}`)
              .join(',')}}) => {${callbackCode}\n})`

            result.code = code
          }

          if (ssr) {
            let ssrInjectCode =
              `\nimport { ssrRegisterHelper } from "${ssrRegisterHelperId}"` +
              `\nconst __moduleId = ${JSON.stringify(id)}`
            for (const { local } of hotComponents) {
              ssrInjectCode += `\nssrRegisterHelper(${local}, __moduleId)`
            }
            result.code += ssrInjectCode
          }
        }

        return {
          code: result.code,
          map: result.map
        }
      }
    }
  }
}

/**
 * @param {import('@babel/core').types.VariableDeclaration} node
 * @param {string} source
 */
function parseComponentDecls(node, source) {
  const names = []
  for (const decl of node.declarations) {
    if (decl.id.type === 'Identifier' && isDefineComponentCall(decl.init)) {
      names.push({
        name: decl.id.name
      })
    }
  }
  return names
}

/**
 * @param {import('@babel/core').types.Node} node
 */
function isDefineComponentCall(node) {
  return (
    node &&
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === 'defineComponent'
  )
}

module.exports = tsPlugin
tsPlugin.default = tsPlugin
