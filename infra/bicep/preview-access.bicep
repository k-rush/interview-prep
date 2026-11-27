param principalId string
resource role 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, 'demo-preview')
  properties: {
    roleName: 'Demo infrastructure preview ${uniqueString(resourceGroup().id)}'
    description: 'Read and preview this ring, without permission to apply a deployment.'
    type: 'CustomRole'
    assignableScopes: [resourceGroup().id]
    permissions: [{
      actions: ['*/read', 'Microsoft.Resources/deployments/whatIf/action', 'Microsoft.Resources/deployments/validate/action']
    }]
  }
}
resource grant 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, role.id, principalId)
  properties: { roleDefinitionId: role.id, principalId: principalId, principalType: 'ServicePrincipal' }
}
