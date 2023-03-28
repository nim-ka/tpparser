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
        
        if (txt[i] == "*") {
            cur.children.push({ type: "star" })
            i++
            continue
        }
        
        if (txt[i] == "%") {
            cur.children.push({ type: "percent" })
            i++
            continue
        }
        
        if (txt[i] == "=") {
            cur.children.push({ type: "eq" })
            i++
            continue
        }
        
        if (txt[i] == "|") {
            cur.children.push({ type: "or" })
            i++
            continue
        }
        
        if (txt[i] == ";") {
            cur.children.push({ type: "end" })
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
        
        if (!isIdent(txt[i])) {
            throw new Error(`Unrecognized character ${txt[i]}`)
        }
        
        let name = ""
            
        while (isIdent(txt[i])) {
            name += txt[i]
            i++
        }
        
        cur.children.push({
            type: type,
            value: name
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
        if (root.children[i].type == "end") {
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
        
        if (statement[i].type == "star") {
            wrapper = true
            i++
        }
        
        if (statement[i].type == "percent") {
            deprioritize = true
            i++
        }
        
        if (statement[i].type != "eq") {
            throw new Error(`Malformed statement`)
        }
        
        i++
        
        let matches = [[]]
        
        for (; i < statement.length; i++) {
            if (statement[i].type == "or") {
                matches.push([])
            } else {
                matches.at(-1).push(statement[i])
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
        
        matches.wrapper = wrapper
        matches.deprioritize = deprioritize
        
        result[key.value] = matches
    }
    
    return result
}

function copy(tree) {
    return tree == null ? null : {
        type: tree.type,
        expect: tree.expect.slice(),
        done: tree.done,
        wrapper: tree.wrapper,
        deprioritize: tree.deprioritize,
        parent: copy(tree.parent),
        children: tree.children.slice()
    }
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

function match(grammar, target, tokens) {
    let fronts = []
    let rule = grammar[target]
    
    for (let i = 0; i < rule.length; i++) {
        fronts.push({
            type: target,
            expect: rule[i].slice(),
            done: false,
            wrapper: rule.wrapper,
            deprioritize: false,
            parent: null,
            children: []
        })
    }
    
    for (let token of tokens) {
        fronts.sort((a, b) => a.deprioritize ? 1 : b.deprioritize ? -1 : 0)
        
        for (let i = 0; i < fronts.length; i++) {
            while (fronts[i] != null) {
                if (fronts[i].expect.length == 0) {
                    fronts[i] = null
                    break
                }
                
                let next = fronts[i].expect.shift()
                
                if (next.type == "literal") {
                    if (token == next.value) {
                        fronts[i].children.push(token)
                    
                        if (fronts[i].expect.length == 0) {
                            fronts[i].done = true
                            
                            while (fronts[i].done) {
                                if (fronts[i].parent == null) {
                                    break
                                }
                                
                                fronts[i].parent.children.push(fronts[i])
                                fronts[i] = fronts[i].parent
                                fronts[i].done = fronts[i].expect.length == 0
                            }
                        }
                        
                        break
                    } else {
                        fronts[i] = null
                    }
                } else if (next.type == "token") {
                    let nexts = []
                    let name = next.value
                    let rule = grammar[name]
                    
                    for (let j = 0; j < rule.length; j++) {
                        nexts.push({
                            type: name,
                            expect: rule[j].slice(),
                            done: false,
                            wrapper: rule.wrapper,
                            deprioritize: fronts[i].deprioritize || rule.deprioritize,
                            parent: copy(fronts[i]),
                            children: []
                        })
                    }
                    
                    fronts.splice(i, 1, ...nexts)
                }
            }
        }
        
        fronts = fronts.filter((e) => e != null)
    }
    
    let cleaned = []
    
    for (let tree of fronts) {
        if (tree.done && tree.parent == null) {
            cleaned.push(clean(copy(tree)))
        }
    }
    
    return cleaned
}

function print(tree, offset = 0) {
    let str = typeof tree == "object" ? tree.type + ":" : "\x1b[32m" + tree + "\x1b[0m"
    
    console.log(" ".repeat(offset) + str)
    
    if (typeof tree == "object") {
        for (let child of tree.children) {
            print(child, offset + 2)
        }
    }
}

let grammar = parse(fs.readFileSync(args[0], "utf8"))
let sentences = args[1].split(".")

for (let sentence of sentences) {
    sentence = sentence.trim()
    
    console.log(`--------------- "${sentence}"`)
    
    let tokens = sentence.match(/[a-z]+/g) ?? []
    let res = match(grammar, "sentence", tokens)

    for (let i = 0; i < res.length; i++) {
        print(res[i])
        
        if (first) {
            break
        }
        
        if (i < res.length - 1) {
            console.log()
        }
    }
}