/**
 *    Copyright (C) 2018-present MongoDB, Inc.
 *
 *    This program is free software: you can redistribute it and/or modify
 *    it under the terms of the Server Side Public License, version 1,
 *    as published by MongoDB, Inc.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    Server Side Public License for more details.
 *
 *    You should have received a copy of the Server Side Public License
 *    along with this program. If not, see
 *    <http://www.mongodb.com/licensing/server-side-public-license>.
 *
 *    As a special exception, the copyright holders give permission to link the
 *    code of portions of this program with the OpenSSL library under certain
 *    conditions as described in each individual source file and distribute
 *    linked combinations including the program with the OpenSSL library. You
 *    must comply with the Server Side Public License in all respects for
 *    all of the code used other than as permitted herein. If you modify file(s)
 *    with this exception, you may extend this exception to your version of the
 *    file(s), but you are not obligated to do so. If you do not wish to do so,
 *    delete this exception statement from your version. If you delete this
 *    exception statement from all source files in the program, then also delete
 *    it in the license file.
 */

#pragma once

#include <absl/container/flat_hash_map.h>
#include <absl/container/node_hash_map.h>
#include <algorithm>
#include <cstdint>
#include <functional>
#include <iterator>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "mongo/base/string_data.h"
#include "mongo/bson/bsonobj.h"
#include "mongo/bson/bsonobjbuilder.h"
#include "mongo/db/exec/document_value/document.h"
#include "mongo/db/exec/document_value/value.h"
#include "mongo/db/operation_context.h"
#include "mongo/db/pipeline/legacy_runtime_constants_gen.h"
#include "mongo/stdx/unordered_map.h"
#include "mongo/util/assert_util.h"
#include "mongo/util/string_map.h"

namespace mongo {
class ExpressionContext;
class VariablesParseState;

/**
 * The state used as input and working space for Expressions.
 */
class Variables final {
public:
    // Each unique variable is assigned a unique id of this type. Negative ids are reserved for
    // system variables and non-negative ids are allocated for user variables.
    using Id = int64_t;

    /**
     * Generate runtime constants using the current local and cluster times.
     */
    static LegacyRuntimeConstants generateRuntimeConstants(OperationContext* opCtx);

    /**
     * Generates Variables::Id and keeps track of the number of Ids handed out. Each successive Id
     * generated by an instance of this class must be greater than all preceding Ids.
     */
    class IdGenerator {
    public:
        IdGenerator() : _nextId(0) {}

        Variables::Id generateId() {
            return _nextId++;
        }

    private:
        Variables::Id _nextId;
    };

    Variables() = default;

    static bool isUserDefinedVariable(Variables::Id id) {
        return id >= 0;
    }

    /**
     * Returns 'true' if any of the 'vars' appear in the passed 'ids' set.
     */
    static bool hasVariableReferenceTo(const std::set<Variables::Id>& vars,
                                       const std::set<Variables::Id>& ids) {
        std::vector<Variables::Id> match;
        std::set_intersection(
            vars.begin(), vars.end(), ids.begin(), ids.end(), std::back_inserter(match));
        return !match.empty();
    }

    // Ids for builtin variables.
    static constexpr auto kRootId = Id(-1);
    static constexpr auto kRemoveId = Id(-2);
    static constexpr auto kNowId = Id(-3);
    static constexpr auto kClusterTimeId = Id(-4);
    static constexpr auto kJsScopeId = Id(-5);
    static constexpr auto kIsMapReduceId = Id(-6);
    static constexpr auto kSearchMetaId = Id(-7);
    static constexpr auto kUserRolesId = Id(-8);

    // Map from builtin var name to reserved id number.
    static const StringMap<Id> kBuiltinVarNameToId;
    static const std::map<StringData, std::function<void(const Value&)>> kSystemVarValidators;
    static const std::map<Id, std::string> kIdToBuiltinVarName;

    /**
     * Sets the value of a user-defined variable. Illegal to use with the reserved builtin variables
     * defined above.
     */
    void setValue(Variables::Id id, const Value& value);

    /**
     * Same as 'setValue' but marks 'value' as being constant. It is illegal to change a value that
     * has been marked constant.
     */
    void setConstantValue(Variables::Id id, const Value& value);

    /**
     * Same as 'setValue' but is only allowed on reserved, builtin, variables. Should not be used
     * when setting from user input.
     */
    void setReservedValue(Variables::Id id, const Value& value, bool isConstant);

    /**
     * Gets the value of a user-defined or system variable. If the 'id' provided represents the
     * special ROOT variable, then we return 'root' in Value form.
     */
    Value getValue(Variables::Id id, const Document& root) const;

    /**
     * Gets the value of a user-defined or system variable. Skips user-facing checks and does not
     * return the Document for ROOT.
     */
    auto getValue(Variables::Id id) const {
        return getValue(id, Document{});
    }

    /**
     * Gets the value of a user-defined variable. Should only be called when we know 'id' represents
     * a user-defined variable.
     */
    Value getUserDefinedValue(Variables::Id id) const;

    /**
     * Returns whether a constant value for 'id' has been defined using setConstantValue().
     */
    bool hasConstantValue(Variables::Id id) const {
        auto it = _definitions.find(id);
        return (it != _definitions.end() && it->second.isConstant);
    }

    /**
     * Returns Document() for non-document values, but otherwise identical to getValue(). If the
     * 'id' provided represents the special ROOT variable, then we return 'root'.
     */
    Document getDocument(Variables::Id id, const Document& root) const;

    IdGenerator* useIdGenerator() {
        return &_idGenerator;
    }

    /**
     * Set the runtime constants. It is a programming error to call this more than once.
     */
    void setLegacyRuntimeConstants(const LegacyRuntimeConstants& constants);

    /**
     * Set the runtime constants using the current local and cluster times.
     */
    void setDefaultRuntimeConstants(OperationContext* opCtx);

    /**
     * Seed let parameters with the given BSONObj.
     */
    void seedVariablesWithLetParameters(ExpressionContext* expCtx, BSONObj letParameters);

    /**
     * Serializes this Variables object to a BSONObj, according to the top level field names of
     * 'varsToSerialize'.
     */
    BSONObj toBSON(const VariablesParseState& vps, const BSONObj& varsToSerialize) const;

    bool hasValue(Variables::Id id) const {
        return _definitions.find(id) != _definitions.end();
    };

    void appendSystemVariables(BSONObjBuilder& bob) const;

    /**
     * Copies this Variables and 'vps' to the Variables and VariablesParseState objects in 'expCtx'.
     * The VariablesParseState's 'idGenerator' in 'expCtx' is replaced with the pointer to the
     * 'idGenerator' in the new copy of the Variables instance.
     *
     * Making such a copy is a way to ensure that variables visible to a new "scope" (a subpipeline)
     * end up with lexical scoping and do not leak into the execution of the parent pipeline at
     * runtime.
     */
    void copyToExpCtx(const VariablesParseState& vps, ExpressionContext* expCtx) const;

    LegacyRuntimeConstants transitionalExtractRuntimeConstants() const;

    static auto getBuiltinVariableName(Variables::Id variable) {
        for (auto& [name, id] : kBuiltinVarNameToId) {
            if (variable == id) {
                return name;
            }
        }
        MONGO_UNREACHABLE_TASSERT(5858104);
    }

    /**
     * Return true if the passed-in variable ID belongs to a builtin variable.
     */
    static auto isBuiltin(Variables::Id variable) {
        return kIdToBuiltinVarName.find(variable) != kIdToBuiltinVarName.end();
    }

    /**
     * Define the value of the $$USER_ROLES variable.
     */
    void defineUserRoles(OperationContext* opCtx);

private:
    struct ValueAndState {
        ValueAndState() = default;

        ValueAndState(Value val, bool isConst) : value(std::move(val)), isConstant(isConst) {}

        Value value;
        bool isConstant = false;
    };

    void setValue(Id id, const Value& value, bool isConstant);

    IdGenerator _idGenerator;
    stdx::unordered_map<Id, ValueAndState> _definitions;
};

/**
 * This class represents the Variables that are defined in an Expression tree.
 *
 * All copies from a given instance share enough information to ensure unique Ids are assigned
 * and to propagate back to the original instance enough information to correctly construct a
 * Variables instance.
 */
class VariablesParseState final {
public:
    explicit VariablesParseState(Variables::IdGenerator* variableIdGenerator)
        : _idGenerator(variableIdGenerator) {}

    /**
     * Assigns a named variable a unique Id. This differs from all other variables, even
     * others with the same name.
     *
     * The special variables ROOT and CURRENT are always implicitly defined with CURRENT
     * equivalent to ROOT. If CURRENT is explicitly defined by a call to this function, it
     * breaks that equivalence.
     *
     * NOTE: Name validation is responsibility of caller.
     */
    Variables::Id defineVariable(StringData name);

    /**
     * Returns true if there are any variables defined in this scope.
     */
    bool hasDefinedVariables() const {
        return !_variables.empty();
    }

    /**
     * Returns the current Id for a variable. uasserts if the variable isn't defined.
     */
    Variables::Id getVariable(StringData name) const;

    /**
     * Returns the set of variable IDs defined at this scope.
     */
    std::set<Variables::Id> getDefinedVariableIDs() const;

    /**
     * Serializes a map from name to values of defined variables.
     */
    BSONObj serialize(const Variables& vars) const;

    /**
     * Splits defined variables into runtime constants and "the rest" as a transitional tool while
     * we phase out using LegacyRuntimeConstants.
     */
    std::pair<LegacyRuntimeConstants, BSONObj> transitionalCompatibilitySerialize(
        const Variables& vars) const;

    /**
     * Return a copy of this VariablesParseState. Will replace the copy's '_idGenerator' pointer
     * with 'idGenerator'.
     */
    VariablesParseState copyWith(Variables::IdGenerator* idGenerator) const {
        VariablesParseState vps = *this;
        vps._idGenerator = idGenerator;
        return vps;
    }

private:
    // Not owned here.
    Variables::IdGenerator* _idGenerator;

    StringMap<Variables::Id> _variables;
    Variables::Id _lastSeen = -1;
};
}  // namespace mongo
