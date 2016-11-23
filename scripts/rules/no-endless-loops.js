"use strict"

/**
 * An ESLint rule used within this project to prohibit loops that don't
 * explicitly terminate. The rationale is that loops without a terminating
 * condition may create bugs where the code never breaks when it should.
 *
 * Note that this is *not* duplicative of most other rules (e.g.
 * `no-constant-condition` and `no-unmodified-loop-condition` already catches
 * most of this between the two, but they don't catch empty `for` conditions).
 * It's also slightly more restrictive than the built-in `no-constant-condition`
 * rule.
 */

exports.meta = {
    docs: {
        description: "Prevent loops without a clear condition",
        category: "Best Practices",
    },
    schema: [],
}

exports.create = context => ({
    WhileStatement: check(context),
    ForStatement: check(context),
})

function check(context) {
    return node => {
        if (isConstant(node.test, true)) {
            context.report({node, message: "Possibly endless loop."})
        }
    }
}

function isConstant(node, isCondition) {
    if (node == null) return true
    switch (node.type) {
    case "Literal":
    case "ClassExpression":
    case "FunctionExpression":
    case "ArrayExpression":
        return true

    case "UnaryExpression":
        switch (node.operator) {
        case "delete": return false
        case "typeof": return isCondition || isConstant(node.argument, false)
        case "void": return true
        default: return isConstant(node.argument, isCondition)
        }

    case "BinaryExpression":
        return isConstant(node.left, false) &&
            isConstant(node.right, false)

    case "LogicalExpression":
        return isConstant(node.left, isCondition) &&
            isConstant(node.right, isCondition)

    case "AssignmentOperator":
        return isConstant(node.right, isCondition)

    case "ConditionalExpression":
        return isConstant(node.test, true) &&
            isConstant(node.consequent, isCondition) &&
            isConstant(node.alternate, isCondition)

    case "SequenceExpression":
    case "TemplateLiteral":
        return node.expressions.every(child => isConstant(child, false))

    default:
        return false
    }
}
