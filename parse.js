const fs = require("fs")

let args = process.argv.slice(2)

function getarg(args, key) {
    let idx = args.indexOf(key)
    
    if (idx > -1) {
        args.splice(idx, 1)
        return true
    }
    
    return false
}

let prune = getarg(args, "--prune")
let first = getarg(args, "--first")

function isIdent(str) {
    return /^[A-Za-z0-9_]+$/.test(str)
}

function tokenize(txt) {
    let root = {
        type: "root",
        parent: null,
        children: []
    }
    
    let cur = root
    let i = 0
    
    while (i < txt.length) {
        if (/\s/.test(txt[i])) {
            i++
            continue
        }
        
        if (txt[i] == "#") {
            while (txt[i] != "\n") {
                i++
            }
            
            continue
        }
        
        if ("@*%=|;".includes(txt[i])) {
            cur.children.push({ type: txt[i] })
            i++
            continue
        }
        
        if (txt[i] == "[") {
            let token = {
                type: "optional",
                parent: cur,
                children: []
            }
            
            cur.children.push(token)
            cur = token
            i++
            continue
        }
        
        if (txt[i] == "]" && cur.parent != null) {
            cur = cur.parent
            i++
            continue
        }
        
        let type = isIdent(txt[i]) ? "key" :
            txt[i] == "$" ? (i++, "literal") :
            txt[i] == "<" ? (i++, "token") : null
        let name = ""
        
        if (txt[i] == "/") {
            i++
            
            let regex = ""
            
            while (txt[i] != "/") {
                regex += txt[i]
                i++
            }
            
            i++
            
            name = new RegExp(regex)
        } else {
            if (!isIdent(txt[i])) {
                throw new Error(`Unrecognized character ${txt[i]}`)
            }
                
            while (isIdent(txt[i])) {
                name += txt[i]
                i++
            }
        }
        
        cur.children.push({
            type: type,
            value: [name]
        })
        
        if (type == "token" && txt[i] == ">") {
            i++
        }
    }
    
    return root
}

function parse(str) {
    let root = tokenize(str)
    let statements = [[]]
    
    for (let i = 0; i < root.children.length; i++) {
        if (root.children[i].type == ";") {
            statements.push([])
        } else {
            statements.at(-1).push(root.children[i])
        }
    }
    
    let result = {}
    
    for (let statement of statements) {
        if (statement.length == 0) {
            continue
        }
        
        let key = statement[0]
        
        if (key.type != "key") {
            throw new Error(`Malformed statement`)
        }
        
        let wrapper = false
        let deprioritize = false
        
        let i = 1
        
        if (statement[i].type == "*") {
            wrapper = true
            i++
        }
        
        if (statement[i].type == "%") {
            deprioritize = true
            i++
        }
        
        if (statement[i].type != "=") {
            throw new Error(`Malformed statement`)
        }
        
        i++
        
        let matches = [[]]
        
        for (; i < statement.length; i++) {
            if (statement[i].type == "|") {
                matches.push([])
            } else if (
                statement[i].type == "literal" ||
                statement[i].type == "token" ||
                statement[i].type == "optional") {
                matches.at(-1).push(statement[i])
            } else {
                throw new Error(`Malformed statement: unexpected token of type ${statement[i].type}`)
            }
        }
        
        for (let i = 0; i < matches.length; i++) {
            for (let j = 0; j < matches[i].length; j++) {
                if (matches[i][j].type == "optional") {
                    let newMatch = matches[i].slice()
                    newMatch.splice(j, 1, ...matches[i][j].children)
                    matches[i].splice(j, 1)
                    matches.splice(i, 0, newMatch)
                }
            }
        }
        
        if (matches.every((e) => e.length == 1) && !matches.some((e) => e[0].type != matches[0][0].type)) {
            matches = [
                [{
                    type: matches[0][0].type,
                    value: matches.reduce((a, b) => [...a, b[0].value[0]], [])
                }]
            ]
        }
        
        matches.wrapper = wrapper
        matches.deprioritize = deprioritize
        
        result[key.value] = matches
    }
    
    return result
}

function addError(errors, type, tree, expected, suggestion) {
    let head = shallowCopy(tree)
    tree = head
    
    while (tree.parent != null) {
        tree.parent = shallowCopy(tree.parent)
        tree.parent.children.push(tree)
        tree = tree.parent
    }
    
    errors.push({ type, tree, head, expected, suggestion })
}

function shallowCopy(tree) {
    return tree == null ? null : {
        id: tree.id,
        type: tree.type,
        expect: tree.expect.slice(),
        done: tree.done,
        wrapper: tree.wrapper,
        deprioritize: tree.deprioritize,
        parent: tree.parent,
        children: tree.children.slice()
    }
}

function deepCopy(tree) {
    tree = shallowCopy(tree)
    
    if (tree) {
        tree.parent = deepCopy(tree.parent)
    }
    
    return tree
}

function clean(tree) {
    if (typeof tree == "object") {
        for (let i = 0; i < tree.children.length; i++) {
            if (prune && tree.children[i].wrapper) {
                tree.children.splice(i, 1, ...tree.children[i].children)
                i--
            }
        }
        
        for (let i = 0; i < tree.children.length; i++) {
            tree.children[i] = clean(tree.children[i])
        }
    }
    
    return tree
}

function match(grammar, target, tokens, errorsStart) {
    let fronts = []
    let rule = grammar[target]
    let id = 0
    
    for (let i = 0; i < rule.length; i++) {
        fronts.push({
            id: id++,
            type: target,
            expect: rule[i].slice(),
            done: false,
            wrapper: rule.wrapper,
            deprioritize: false,
            parent: null,
            children: []
        })
    }
    
    let lastErrors = []
    let tokensSoFar = []
    
    for (let tokenNum = 0; tokenNum <= tokens.length; tokenNum++) {
        let token = tokens[tokenNum]
        let errors = []
        let makeError = tokenNum >= errorsStart
        
        if (tokenNum >= tokens.length) {
            token = "END"
            makeError = tokens.length - 1 >= errorsStart // Prioritize end of input errors same as last token errors
        }
        
        fronts.sort((a, b) => a.deprioritize ? 1 : b.deprioritize ? -1 : 0)
        
        for (let i = 0; i < fronts.length; i++) {
            while (fronts[i] != null) {
                if (fronts[i].expect.length == 0) {
                    if (token != "END") {
                        if (makeError) {
                            addError(
                                errors,
                                `Unexpected token ${token}`,
                                fronts[i],
                                `end of input`,
                                [...tokensSoFar])
                        }
                        
                        fronts[i] = null
                    }
                    
                    break
                }
                
                let next = fronts[i].expect.shift()
                
                if (next.type == "literal") {
                    if (next.value.some((e) => e instanceof RegExp ? token.match(e) : token == e)) {
                        fronts[i].children.push(token)
                    
                        if (fronts[i].expect.length == 0) {
                            fronts[i].done = true
                            
                            while (fronts[i].done) {
                                if (fronts[i].parent == null) {
                                    break
                                }
                                
                                fronts[i].parent = shallowCopy(fronts[i].parent)
                                fronts[i].parent.children.push(fronts[i])
                                fronts[i] = fronts[i].parent
                                fronts[i].done = fronts[i].expect.length == 0
                            }
                        }
                    } else {
                        if (makeError) {
                            let suggestion = next.value[0]
                            
                            if (suggestion instanceof RegExp) {
                                suggestion = "Alesa"
                            }
                            
                            addError(
                                errors,
                                token == "END" ? `Unexpected end of input` : `Unexpected token ${token}`,
                                fronts[i],
                                fronts[i].children.length == 0 ? fronts[i].type : `"${next.value[0]}"`,
                                [...tokensSoFar, next.value[0]])
                        }
                        
                        fronts[i] = null
                    }
                    
                    break
                } else if (next.type == "token") {
                    let nexts = []
                    
                    for (let name of next.value) {
                        let rule = grammar[name]
                        
                        for (let j = 0; j < rule.length; j++) {
                            nexts.push({
                                id: id++,
                                type: name,
                                expect: rule[j].slice(),
                                done: false,
                                wrapper: rule.wrapper,
                                deprioritize: fronts[i].deprioritize || rule.deprioritize,
                                parent: fronts[i],
                                children: []
                            })
                        }
                    }
                    
                    fronts.splice(i, 1, ...nexts)
                }
            }
            
            /*
            if (fronts[i] != null) {
                let tree = shallowCopy(fronts[i])
                
                while (tree.parent != null) {
                    tree.parent = shallowCopy(tree.parent)
                    tree.parent.children.push(tree)
                    tree = tree.parent
                }
                
                console.clear()
                console.log(token)
                console.log()
                print(tree, fronts[i])
            }
            */
        }
        
        fronts = fronts.filter((e) => e != null)
        
        if (errors.length) {
            lastErrors = errors
        }
        
        tokensSoFar.push(token)
    }
    
    let success = true
    let results = fronts.filter((e) => e.done && e.parent == null)
    let errors = []
    
    if (results.length == 0) {
        success = false
        errors = lastErrors
        results = errors.map((e) => e.tree)
    }
    
    results = results.map((e) => clean(deepCopy(e)))
    
    return { success, results, errors }
}

function print(tree, highlight, offset = 0) {
    let str = typeof tree == "object" ? tree.type + ":" : "\x1b[32m" + tree + "\x1b[0m"
    
    if (highlight && tree.id == highlight.id) {
        str += " \x1b[31m<~\x1b[0m"
    }
    
    console.log(" ".repeat(offset) + str)
    
    if (typeof tree == "object") {
        for (let child of tree.children) {
            print(child, highlight, offset + 2)
        }
    }
}

let grammar = parse(fs.readFileSync(args[0], "utf8"))
let sentences = args[1].split(/[.:]/)

for (let sentence of sentences) {
    let tokens = sentence.match(/[A-Za-z]+/g) ?? []
    
    console.log(`--------------- \x1b[33m"${tokens.join(" ")}"\x1b[0m`)
    
    let errorsStart = tokens.length
    let { success, results, errors } = match(grammar, "sentence", tokens, errorsStart)
    
    if (success) {
        console.log(`\x1b[36mFound ${results.length} interpretation${results.length == 1 ? "" : "s"}\x1b[0m\n`)

        for (let i = 0; i < results.length; i++) {
            print(results[i])
            
            if (first) {
                break
            }
            
            if (i < results.length - 1) {
                console.log()
            }
        }
    } else {
        console.log(`\x1b[31mFailed to parse sentence.\nChecking for errors...\x1b[0m\n`)
        
        while (errors.length == 0) {
            ({ success, results, errors } = match(grammar, "sentence", tokens, --errorsStart))
        }
        
        errors = errors.map((e, i) => ({
            error: e,
            result: results[i]
        })).filter((e, i, a) => a.findIndex((f) => e.error.expected == f.error.expected) == i)
        
        for (let i = 0; i < errors.length; i++) {
            console.log(`\x1b[31m${errors[i].error.type}; expected ${errors[i].error.expected} ("${errors[i].error.suggestion.join(" ")}${errors[i].error.expected == "end of input" ? "" : " [...]"}"?)\x1b[0m`)
            print(errors[i].result, errors[i].error.head)
            
            if (first) {
                break
            }
            
            if (i < errors.length - 1) {
                console.log()
            }
        }
    }
}