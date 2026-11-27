@description('Existing, explicitly authorized non-production Azure OpenAI account.')
param accountName string
param testPrincipalId string
resource account 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = { name: accountName }
resource role 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(account.id, testPrincipalId, 'responses-create-only')
  properties: {
    roleName: 'Synthetic test response generation ${uniqueString(testPrincipalId)}'
    description: 'Create a model response; no keys, model administration, or access to saved responses.'
    type: 'CustomRole'
    assignableScopes: [resourceGroup().id]
    permissions: [{ dataActions: ['Microsoft.CognitiveServices/accounts/OpenAI/responses/write'] }]
  }
}
resource grant 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: account
  name: guid(account.id, testPrincipalId, role.name)
  properties: { roleDefinitionId: role.id, principalId: testPrincipalId, principalType: 'ServicePrincipal' }
}
output assignmentId string = grant.id
output definitionId string = role.id
