let prune = true

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
                displayError(`Unrecognized character ${txt[i]}`)
                return null
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
    
    if (root == null) {
        return null
    }
    
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
            displayError(`Malformed statement: expected token of type key, got token of type ${key.type}`)
            return null
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
            displayError(`Malformed statement: expected token of type =, got token of type ${statement[i].type}`)
            return null
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
                displayError(`Malformed statement: unexpected token of type ${statement[i].type}`)
                return null
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

function displayTree(tree, div, highlight = false) {
    if (typeof tree == "object") {
        let label = document.createElement("div")
        label.classList.add("label")
        label.innerText = tree.type
        
        let node = document.createElement("div")
        node.classList.add("node")
        
        if (highlight && tree.id == highlight.id) {
            node.classList.add("highlight")
        }
        
        node.appendChild(label)
        div.appendChild(node)
        
        for (let child of tree.children) {
            displayTree(child, node, highlight)
        }
    } else {
        let node = document.createTextNode(tree)
        div.appendChild(node)
    }
}

let grammar = null
let res = null
let chosenResult = 0

async function loadGrammar(file) {
    clearDisplay()
    
    let res = await fetch(file)
    grammar = parse(await res.text())
    
    if (grammar == null) {
        displayError(`Unable to load grammar file`)
    }
}

function updateParse() {
    clearDisplay()
    
    if (grammar == null) {
        displayError(`Unable to load grammar file`)
        return
    }
    
    let sentence = document.getElementById("text").value
    let tokens = sentence.match(/[A-Za-z]+/g) ?? []
    
    let errorsStart = tokens.length
    res = match(grammar, "sentence", tokens, errorsStart)
    
    if (!res.success) {
        while (res.errors.length == 0 && errorsStart >= 0) {
            res = match(grammar, "sentence", tokens, --errorsStart)
        }
        
        res.errors = res.errors.map((e, i) => ({
            error: e,
            tree: res.results[i]
        })).filter((e, i, a) => a.findIndex((f) => e.error.expected == f.error.expected) == i)
    }
    
    chosenResult = 0
    updateDisplay()
}

function displayError(str) {
    let errorDiv = document.getElementById("error")
    
    errorDiv.innerText = str
}

function clearDisplay() {
    let headerDiv = document.getElementById("header")
    let errorDiv = document.getElementById("error")
    let displayDiv = document.getElementById("display")
    let selectorsDiv = document.getElementById("selectors")
    
    headerDiv.replaceChildren()
    errorDiv.replaceChildren()
    displayDiv.replaceChildren()
    selectorsDiv.classList.add("hide")
}

function updateDisplay() {
    let headerDiv = document.getElementById("header")
    let errorDiv = document.getElementById("error")
    let displayDiv = document.getElementById("display")
    let selectorsDiv = document.getElementById("selectors")
    
    if (res == null) {
        displayError(`An error occurred`)
        return
    }
    
    if (res.success) {
        let tree = res.results[chosenResult]
        
        headerDiv.innerText = `Found ${res.results.length} interpretation${res.results.length == 1 ? "" : "s"}.`
        
        displayTree(tree, displayDiv)
    } else {
        let { error, tree } = res.errors[chosenResult]
        
        headerDiv.innerText = `Failed to parse sentence. ${res.errors.length} possible fix${res.errors.length == 1 ? "" : "es"} found.`
        errorDiv.innerText = `${error.type}; expected ${error.expected} ("${error.suggestion.join(" ")}${error.expected == "end of input" ? "" : " [...]"}"?)`
        
        displayTree(tree, displayDiv, error.head)
    }
    
    updateSelectors()
    selectorsDiv.classList.remove("hide")
}

function updateSelectors() {
    let resultNumSpan = document.getElementById("resultnum")
    resultNumSpan.innerText = chosenResult + 1;
}

function selectLeft() {
    chosenResult = (chosenResult + res.results.length - 1) % res.results.length
    clearDisplay()
    updateDisplay()
}

function selectRight() {
    chosenResult = (chosenResult + 1) % res.results.length
    clearDisplay()
    updateDisplay()
}

window.addEventListener("load", () => loadGrammar("nasin_alesa.txt"))
